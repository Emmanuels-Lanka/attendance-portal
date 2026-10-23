import "server-only";

import { randomUUID } from "node:crypto";
import { AttendanceDailyCalculationTaskStatus, Prisma, type PrismaClient, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  AttendanceDailyCorrectionProtectedError,
  calculateAndPersistDailyAttendanceInTransaction,
} from "./engine-service";
import { lockAttendanceUser } from "./locks";

const batchSize = 2;
const maximumAttempts = 8;
const leaseDurationMs = 90_000;
const transactionTimeoutMs = 8_000;
const transactionMaxWaitMs = 2_000;
const retryBaseMs = 60_000;
const retryMaximumMs = 6 * 60 * 60_000;

type QueueDatabase = Pick<PrismaClient, "$transaction">;
type ClaimedTask = {
  id: string;
  employeeId: string;
  attendanceDate: Date;
  timeZone: string;
  requestedVersion: number;
  attempts: number;
  leaseToken: string;
};

export type AttendanceReconciliationSummary = {
  claimed: number;
  pending: number;
  calculated: number;
  protected: number;
  skippedInactive: number;
  unlinkedEmployees: number;
  superseded: number;
  retried: number;
  deadLettered: number;
  failureCategories: Record<string, number>;
};

export async function enqueueDailyAttendanceCalculation(
  transaction: Prisma.TransactionClient,
  input: {
    employeeId: string;
    attendanceDate: string;
    timeZone: string;
    punchId: string;
  },
) {
  const date = new Date(`${input.attendanceDate}T00:00:00.000Z`);
  const existing = await transaction.attendanceDailyCalculationTask.findUnique({
    where: { employeeId_attendanceDate: { employeeId: input.employeeId, attendanceDate: date } },
    select: { id: true },
  });
  const task = existing ?? await transaction.attendanceDailyCalculationTask.create({
    data: {
      employeeId: input.employeeId,
      attendanceDate: date,
      timeZone: input.timeZone,
      lastPunchId: input.punchId,
    },
    select: { id: true },
  });
  const event = await transaction.attendanceDailyCalculationTaskEvent.createMany({
    data: [{ taskId: task.id, punchId: input.punchId }],
    skipDuplicates: true,
  });
  if (event.count === 0 || !existing) return;

  await transaction.attendanceDailyCalculationTask.update({
    where: { id: task.id },
    data: {
      requestedVersion: { increment: 1 },
      status: AttendanceDailyCalculationTaskStatus.PENDING,
      timeZone: input.timeZone,
      lastPunchId: input.punchId,
      availableAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      claimedVersion: null,
      attempts: 0,
      lastErrorCategory: null,
    },
  });
}

function retryDelayMs(attempt: number) {
  return Math.min(retryBaseMs * (2 ** Math.max(0, attempt - 1)), retryMaximumMs);
}

function errorCategory(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return `Prisma_${error.code}`;
  if (error instanceof Error && error.name !== "Error") return error.name.slice(0, 80);
  return error instanceof Error ? "AttendanceCalculationError" : "UnknownAttendanceCalculationError";
}

async function claimTasks(database: QueueDatabase, now: Date): Promise<{
  tasks: ClaimedTask[];
  exhausted: number;
  pending: number;
}> {
  return database.$transaction(async (transaction) => {
    const exhausted = await transaction.attendanceDailyCalculationTask.updateMany({
      where: {
        status: AttendanceDailyCalculationTaskStatus.PROCESSING,
        leaseExpiresAt: { lte: now },
        attempts: { gte: maximumAttempts },
      },
      data: {
        status: AttendanceDailyCalculationTaskStatus.DEAD_LETTER,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCategory: "LeaseExpiredAfterMaximumAttempts",
      },
    });
    const candidates = await transaction.$queryRaw<Array<{
      id: string;
      employeeId: string;
      attendanceDate: Date;
      timeZone: string;
      requestedVersion: number;
      attempts: number;
    }>>`
      SELECT "id", "employeeId", "attendanceDate", "timeZone", "requestedVersion", "attempts"
      FROM "attendance_daily_calculation_tasks"
      WHERE (
        "status" IN ('PENDING', 'RETRY_WAIT') AND "availableAt" <= ${now}
      ) OR (
        "status" = 'PROCESSING' AND "leaseExpiresAt" <= ${now} AND "attempts" < ${maximumAttempts}
      )
      ORDER BY "availableAt" ASC, "createdAt" ASC, "id" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `;

    const tasks: ClaimedTask[] = [];
    for (const candidate of candidates) {
      const leaseToken = randomUUID();
      const claimed = await transaction.attendanceDailyCalculationTask.update({
        where: { id: candidate.id },
        data: {
          status: AttendanceDailyCalculationTaskStatus.PROCESSING,
          attempts: { increment: 1 },
          claimedVersion: candidate.requestedVersion,
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
        },
        select: { attempts: true },
      });
      tasks.push({ ...candidate, attempts: claimed.attempts, leaseToken });
    }
    const pending = await transaction.attendanceDailyCalculationTask.count({
      where: {
        status: { in: [AttendanceDailyCalculationTaskStatus.PENDING, AttendanceDailyCalculationTaskStatus.RETRY_WAIT] },
        availableAt: { lte: now },
      },
    });
    return { tasks, exhausted: exhausted.count, pending };
  }, { maxWait: transactionMaxWaitMs, timeout: transactionTimeoutMs });
}

async function processTask(database: QueueDatabase, task: ClaimedTask) {
  return database.$transaction(async (transaction) => {
    const employeeSnapshot = await transaction.employee.findUnique({
      where: { id: task.employeeId },
      select: { userId: true },
    });
    if (!employeeSnapshot) throw new Error("AttendanceEmployeeMissing");

    if (employeeSnapshot.userId) await lockAttendanceUser(transaction, employeeSnapshot.userId);
    await transaction.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${task.employeeId} FOR UPDATE`;

    const lockedEmployee = await transaction.employee.findUnique({
      where: { id: task.employeeId },
      select: {
        userId: true,
        user: { select: { id: true, role: true, isActive: true } },
      },
    });
    if (lockedEmployee?.userId && lockedEmployee.userId !== employeeSnapshot.userId) {
      throw new Error("AttendanceEmployeeIdentityChanged");
    }
    await transaction.$queryRaw`
      SELECT "id" FROM "attendance_daily_calculation_tasks" WHERE "id" = ${task.id} FOR UPDATE
    `;
    const currentTask = await transaction.attendanceDailyCalculationTask.findUnique({
      where: { id: task.id },
      select: {
        status: true,
        requestedVersion: true,
        leaseToken: true,
        claimedVersion: true,
      },
    });
    if (
      !currentTask
      || currentTask.status !== AttendanceDailyCalculationTaskStatus.PROCESSING
      || currentTask.leaseToken !== task.leaseToken
      || currentTask.claimedVersion !== task.requestedVersion
      || currentTask.requestedVersion !== task.requestedVersion
    ) {
      return "superseded" as const;
    }

    if (!lockedEmployee?.userId || !lockedEmployee.user) {
      await transaction.attendanceDailyCalculationTask.update({
        where: { id: task.id },
        data: {
          status: AttendanceDailyCalculationTaskStatus.COMPLETED,
          completedVersion: task.requestedVersion,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCategory: "UnlinkedEmployee",
        },
      });
      return "unlinked" as const;
    }
    if (
      !lockedEmployee.user.isActive
      || (lockedEmployee.user.role !== Role.EMPLOYEE && lockedEmployee.user.role !== Role.HR_ADMINISTRATOR)
    ) {
      await transaction.attendanceDailyCalculationTask.update({
        where: { id: task.id },
        data: {
          status: AttendanceDailyCalculationTaskStatus.COMPLETED,
          completedVersion: task.requestedVersion,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCategory: "IneligibleUser",
        },
      });
      return "inactive" as const;
    }

    try {
      await calculateAndPersistDailyAttendanceInTransaction(
        task.employeeId,
        task.attendanceDate.toISOString().slice(0, 10),
        transaction,
        task.timeZone,
      );
    } catch (error) {
      if (!(error instanceof AttendanceDailyCorrectionProtectedError)) throw error;
      await transaction.attendanceDailyCalculationTask.update({
        where: { id: task.id },
        data: {
          status: AttendanceDailyCalculationTaskStatus.PROTECTED,
          completedVersion: task.requestedVersion,
          leaseToken: null,
          leaseExpiresAt: null,
          lastErrorCategory: null,
        },
      });
      return "protected" as const;
    }

    const completed = await transaction.attendanceDailyCalculationTask.updateMany({
      where: {
        id: task.id,
        status: AttendanceDailyCalculationTaskStatus.PROCESSING,
        leaseToken: task.leaseToken,
        requestedVersion: task.requestedVersion,
        claimedVersion: task.requestedVersion,
      },
      data: {
        status: AttendanceDailyCalculationTaskStatus.COMPLETED,
        completedVersion: task.requestedVersion,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCategory: null,
      },
    });
    if (completed.count !== 1) throw new Error("AttendanceTaskVersionChangedDuringCalculation");
    return "calculated" as const;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: transactionMaxWaitMs,
    timeout: transactionTimeoutMs,
  });
}

async function recordFailure(database: QueueDatabase, task: ClaimedTask, error: unknown, now: Date) {
  const deadLetter = task.attempts >= maximumAttempts;
  const result = await database.$transaction(async (transaction) =>
    transaction.attendanceDailyCalculationTask.updateMany({
      where: {
        id: task.id,
        status: AttendanceDailyCalculationTaskStatus.PROCESSING,
        leaseToken: task.leaseToken,
      },
      data: {
        status: deadLetter
          ? AttendanceDailyCalculationTaskStatus.DEAD_LETTER
          : AttendanceDailyCalculationTaskStatus.RETRY_WAIT,
        availableAt: deadLetter ? undefined : new Date(now.getTime() + retryDelayMs(task.attempts)),
        leaseToken: null,
        leaseExpiresAt: null,
        claimedVersion: null,
        lastErrorCategory: errorCategory(error),
      },
    }), { maxWait: transactionMaxWaitMs, timeout: transactionTimeoutMs });
  return result.count === 1 ? (deadLetter ? "deadLettered" : "retried") : "superseded";
}

export async function runAttendanceReconciliationWorker(
  now: Date = new Date(),
  database: QueueDatabase = prisma,
): Promise<AttendanceReconciliationSummary> {
  if (!Number.isFinite(now.getTime())) throw new Error("A valid worker timestamp is required.");
  const claim = await claimTasks(database, now);
  const summary: AttendanceReconciliationSummary = {
    claimed: claim.tasks.length,
    pending: claim.pending,
    calculated: 0,
    protected: 0,
    skippedInactive: 0,
    unlinkedEmployees: 0,
    superseded: 0,
    retried: 0,
    deadLettered: claim.exhausted,
    failureCategories: {},
  };

  for (const task of claim.tasks) {
    try {
      const result = await processTask(database, task);
      if (result === "calculated") summary.calculated += 1;
      else if (result === "protected") summary.protected += 1;
      else if (result === "inactive") summary.skippedInactive += 1;
      else if (result === "unlinked") summary.unlinkedEmployees += 1;
      else summary.superseded += 1;
    } catch (error) {
      const result = await recordFailure(database, task, error, now);
      const category = errorCategory(error);
      summary.failureCategories[category] = (summary.failureCategories[category] ?? 0) + 1;
      if (result === "retried") summary.retried += 1;
      else if (result === "deadLettered") summary.deadLettered += 1;
      else summary.superseded += 1;
    }
  }
  return summary;
}
