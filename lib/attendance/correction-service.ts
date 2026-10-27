import "server-only";

import {
  AttendanceCorrectionApprovalStage,
  AttendanceCorrectionStatus,
  type Prisma,
  type PrismaClient,
  type Role,
} from "@prisma/client";
import { z } from "zod";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { canSubmitOwnAttendanceCorrection, hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { getEmployeeLocalDayWindow } from "@/lib/attendance/timezone";
import {
  getActiveManagerDepartmentScope,
  lockActiveManagerDepartmentScope,
  lockEmployeeForApproval,
} from "@/lib/organization/manager-scope";
import {
  calculateAndPersistDailyAttendanceInTransaction,
  applyApprovedAttendanceCorrection,
  AttendanceCorrectionEngineConflictError,
  recalculateAttendanceMonthsFromDatesInTransaction,
} from "@/lib/attendance/engine-service";

type AttendanceCorrectionActor = { id: string; role: Role } | null;
type AttendanceCorrectionDatabase = Pick<PrismaClient, "$transaction">;
type OwnCorrectionDailyAttendance = {
  id: string;
  date: Date;
  firstIn: Date | null;
  lastOut: Date | null;
  status: string | null;
};
type OwnCorrectionAttendanceReadDatabase = {
  attendanceDaily: {
    findMany: (args: {
      where: Prisma.AttendanceDailyWhereInput;
      select: { id: true; date: true; firstIn: true; lastOut: true; status: true };
      orderBy: Array<{ date: "desc" } | { id: "desc" }>;
    }) => Promise<OwnCorrectionDailyAttendance[]>;
  };
};
type OwnCorrectionHistoryDatabase = Pick<PrismaClient, "attendanceCorrectionRequest">;
type OwnCorrectionSessionReadDatabase = Pick<PrismaClient, "workSession">;

const attendanceTimestampValuesSchema = z.object({
  firstIn: z.string().datetime({ offset: true }).nullable().optional(),
  lastOut: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();
const dailyCorrectionValuesSchema = attendanceTimestampValuesSchema
  .refine((values) => Object.keys(values).length > 0, "Provide at least one supported attendance time.");
const attendanceDateCorrectionValuesSchema = attendanceTimestampValuesSchema.extend({
  requestedMode: z.enum(["OFFICE", "WFH"]),
}).strict();
const attendanceDateCorrectionSnapshotSchema = z.object({
  attendanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeZone: z.string().min(1),
  attendanceRecordId: z.string().nullable(),
  dailyAttendance: z.object({
    id: z.string(),
    firstIn: z.string().nullable(),
    lastOut: z.string().nullable(),
  }).nullable(),
  session: z.object({
    id: z.string(),
    recordId: z.string(),
    mode: z.enum(["OFFICE", "WFH"]),
    startAt: z.string(),
    endAt: z.string().nullable(),
  }).nullable(),
});
type AttendanceDateCorrectionSnapshot = z.infer<typeof attendanceDateCorrectionSnapshotSchema>;

export const dailyAttendanceCorrectionInputSchema = z.object({
  requestedValues: dailyCorrectionValuesSchema,
  reason: z.string().trim().min(1, "A correction reason is required.").max(500),
});

export const attendanceDateCorrectionInputSchema = z.object({
  attendanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requestedValues: attendanceTimestampValuesSchema,
  requestedMode: z.enum(["OFFICE", "WFH"]),
  reason: z.string().trim().min(1, "A correction reason is required.").max(500),
}).strict();

export const attendanceSessionModeCorrectionInputSchema = z.object({
  requestedMode: z.enum(["OFFICE", "WFH"]),
  reason: z.string().trim().min(1, "A correction reason is required.").max(500),
}).strict();

export const dailyAttendanceCorrectionDecisionSchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  reason: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().trim().max(500).optional(),
  ),
});

async function assertNoRawPunchEvidenceOnMovedDates(
  transaction: Prisma.TransactionClient,
  employeeRecordId: string,
  timeZone: string,
  transitions: Array<{ label: "IN" | "OUT"; previous: Date | null; next: Date | null }>,
) {
  const displacedDates = new Map<string, { label: "IN" | "OUT"; nextDate: string }>();
  for (const { label, previous, next } of transitions) {
    if (!previous || !next) continue;
    const previousDate = formatInTimeZone(previous, timeZone, "yyyy-MM-dd");
    const nextDate = formatInTimeZone(next, timeZone, "yyyy-MM-dd");
    if (previousDate !== nextDate) displacedDates.set(previousDate, { label, nextDate });
  }

  for (const [date, transition] of displacedDates) {
    const day = getEmployeeLocalDayWindow(fromZonedTime(`${date}T12:00:00.000`, timeZone), timeZone);
    const rawPunches = await transaction.attendanceRaw.findMany({
      where: { employeeId: employeeRecordId, timestamp: { gte: day.startAt, lt: day.endAt } },
      select: { id: true },
      take: 1,
    });
    if (rawPunches.length > 0) {
      throw new DailyAttendanceCorrectionInvalidValuesError(
        `The corrected ${transition.label} cannot move from ${date} to ${transition.nextDate} because raw punch evidence exists on its original employee-local date. Keep the time on ${date}, or ask HR to resolve the raw punch evidence; original punches are preserved.`,
      );
    }
  }
}

export class DailyAttendanceCorrectionAccessError extends Error {
  constructor() {
    super("You do not have permission to request this attendance correction.");
    this.name = "DailyAttendanceCorrectionAccessError";
  }
}

export class DailyAttendanceCorrectionReviewerScopeError extends Error {
  constructor() {
    super("This correction is not assigned to you for review.");
    this.name = "DailyAttendanceCorrectionReviewerScopeError";
  }
}

export class DailyAttendanceCorrectionStageError extends Error {
  constructor() {
    super("This correction is not awaiting your review or has already been finalized.");
    this.name = "DailyAttendanceCorrectionStageError";
  }
}

export class DailyAttendanceCorrectionConflictError extends Error {
  constructor() {
    super("The calculated attendance changed after this correction was requested. Review the current values before deciding.");
    this.name = "DailyAttendanceCorrectionConflictError";
  }
}

export class DailyAttendanceCorrectionReviewerNotFoundError extends Error {
  constructor() {
    super("A correction reviewer must have an active User account.");
    this.name = "DailyAttendanceCorrectionReviewerNotFoundError";
  }
}

export class DailyAttendanceCorrectionRequesterNotFoundError extends Error {
  constructor() {
    super("The requesting User was not found.");
    this.name = "DailyAttendanceCorrectionRequesterNotFoundError";
  }
}

export class DailyAttendanceCorrectionTargetNotFoundError extends Error {
  constructor() {
    super("The calculated daily attendance record was not found.");
    this.name = "DailyAttendanceCorrectionTargetNotFoundError";
  }
}

export class DailyAttendanceCorrectionPendingRequestExistsError extends Error {
  constructor() {
    super("A pending correction request already exists for this attendance date.");
    this.name = "DailyAttendanceCorrectionPendingRequestExistsError";
  }
}

export class DailyAttendanceCorrectionSelfApprovalError extends Error {
  constructor() {
    super("You cannot approve an attendance correction for your own account.");
    this.name = "DailyAttendanceCorrectionSelfApprovalError";
  }
}

export class DailyAttendanceCorrectionSubjectUserNotFoundError extends Error {
  constructor() {
    super("The Employee for this attendance record is not linked to a User account.");
    this.name = "DailyAttendanceCorrectionSubjectUserNotFoundError";
  }
}

export class DailyAttendanceCorrectionSubjectEmployeeNotFoundError extends Error {
  constructor() {
    super("A linked Employee record is required to request attendance correction.");
    this.name = "DailyAttendanceCorrectionSubjectEmployeeNotFoundError";
  }
}

export class DailyAttendanceCorrectionInvalidValuesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyAttendanceCorrectionInvalidValuesError";
  }
}

function canRequestOwnAttendanceCorrection(actor: AttendanceCorrectionActor): actor is Exclude<AttendanceCorrectionActor, null> {
  return Boolean(
    actor
    && canSubmitOwnAttendanceCorrection(actor.role),
  );
}

export async function submitAttendanceDateCorrection(
  actor: AttendanceCorrectionActor,
  input: unknown,
  database: AttendanceCorrectionDatabase = prisma,
) {
  if (!canRequestOwnAttendanceCorrection(actor)) {
    throw new DailyAttendanceCorrectionAccessError();
  }
  const parsed = attendanceDateCorrectionInputSchema.parse(input);
  const dateValue = new Date(`${parsed.attendanceDate}T00:00:00.000Z`);
  if (!Number.isFinite(dateValue.getTime()) || dateValue.toISOString().slice(0, 10) !== parsed.attendanceDate) {
    throw new DailyAttendanceCorrectionInvalidValuesError("Choose a valid attendance date.");
  }

  return database.$transaction(async (transaction) => {
    const requester = await transaction.user.findUnique({
      where: { id: actor.id },
      select: { id: true, role: true, isActive: true, timeZone: true },
    });
    if (!requester || !requester.isActive) throw new DailyAttendanceCorrectionRequesterNotFoundError();
    if (
      requester.role !== actor.role
      || (requester.role !== "EMPLOYEE" && requester.role !== "HR_ADMINISTRATOR")
    ) {
      throw new DailyAttendanceCorrectionAccessError();
    }

    await transaction.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.id} FOR UPDATE`;
    const employee = await transaction.employee.findUnique({
      where: { userId: actor.id },
      select: {
        id: true,
        supervisor: {
          select: {
            userId: true,
            user: { select: { role: true, isActive: true } },
          },
        },
      },
    });
    if (!employee) throw new DailyAttendanceCorrectionSubjectEmployeeNotFoundError();
    await transaction.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${employee.id} FOR UPDATE`;
    if (
      !employee.supervisor?.userId
      || employee.supervisor.user?.role !== "SUPERVISOR"
      || !employee.supervisor.user.isActive
    ) {
      throw new DailyAttendanceCorrectionReviewerNotFoundError();
    }

    const { startAt, endAt } = getEmployeeLocalDayWindow(
      fromZonedTime(`${parsed.attendanceDate}T12:00:00.000`, requester.timeZone),
      requester.timeZone,
    );
    for (const timestamp of [parsed.requestedValues.firstIn, parsed.requestedValues.lastOut]) {
      if (timestamp === undefined || timestamp === null) continue;
      const instant = new Date(timestamp);
      if (!Number.isFinite(instant.getTime()) || instant < startAt || instant >= endAt) {
        throw new DailyAttendanceCorrectionInvalidValuesError(
          "Corrected times must fall within the selected employee-local attendance date.",
        );
      }
    }
    if (parsed.requestedValues.firstIn === null || parsed.requestedValues.lastOut === null) {
      throw new DailyAttendanceCorrectionInvalidValuesError(
        "A correction request must provide actual timestamps; use the existing daily correction form to remove a time.",
      );
    }
    if (
      parsed.requestedValues.firstIn
      && parsed.requestedValues.lastOut
      && new Date(parsed.requestedValues.firstIn) >= new Date(parsed.requestedValues.lastOut)
    ) {
      throw new DailyAttendanceCorrectionInvalidValuesError("The attendance start time must be before the end time.");
    }

    const dailyAttendance = await transaction.attendanceDaily.findFirst({
      where: { employeeId: employee.id, date: dateValue },
      select: { id: true, firstIn: true, lastOut: true, status: true },
    });
    const sessions = await transaction.workSession.findMany({
      where: {
        record: { employeeId: actor.id },
        OR: [
          { startAt: { gte: startAt, lt: endAt } },
          { endAt: { gte: startAt, lt: endAt } },
        ],
      },
      select: { id: true, mode: true, startAt: true, endAt: true, recordId: true },
      orderBy: [{ startAt: "asc" }, { id: "asc" }],
      take: 2,
    });
    const rawPunches = await transaction.attendanceRaw.findMany({
      where: { employeeId: employee.id, timestamp: { gte: startAt, lt: endAt } },
      select: { timestamp: true, punchType: true, workMode: true },
      orderBy: [{ timestamp: "asc" }, { id: "asc" }],
    });
    const attendanceRecords = await transaction.attendanceRecord.findMany({
      where: { employeeId: actor.id, workDate: dateValue },
      select: { id: true, sessions: { select: { id: true } } },
      take: 2,
    });
    if (sessions.length > 1 || attendanceRecords.length > 1) {
      throw new DailyAttendanceCorrectionInvalidValuesError(
        "Multiple attendance records exist for this date; an administrator must resolve them before correction.",
      );
    }
    const session = sessions[0] ?? null;
    const attendanceRecord = attendanceRecords[0] ?? null;
    if (
      (!session && attendanceRecord?.sessions.length)
      || (session && attendanceRecord
        && (attendanceRecord.id !== session.recordId
          || !attendanceRecord.sessions.some(({ id }) => id === session.id)))
    ) {
      throw new DailyAttendanceCorrectionInvalidValuesError(
        "An attendance record for this date contains conflicting sessions; an administrator must resolve it before correction.",
      );
    }
    const originalStart = session?.startAt
      ?? dailyAttendance?.firstIn
      ?? rawPunches.find((punch) => punch.punchType === "IN")?.timestamp
      ?? null;
    const originalEnd = session?.endAt
      ?? dailyAttendance?.lastOut
      ?? [...rawPunches].reverse().find((punch) => punch.punchType === "OUT")?.timestamp
      ?? null;
    const effectiveStart = parsed.requestedValues.firstIn
      ? new Date(parsed.requestedValues.firstIn)
      : originalStart;
    const effectiveEnd = parsed.requestedValues.lastOut
      ? new Date(parsed.requestedValues.lastOut)
      : originalEnd;
    if (!session && !effectiveStart) {
      throw new DailyAttendanceCorrectionInvalidValuesError(
        "A corrected start time or existing IN punch is required when no attendance session exists.",
      );
    }
    if (effectiveStart && effectiveEnd && effectiveStart >= effectiveEnd) {
      throw new DailyAttendanceCorrectionInvalidValuesError("The attendance start time must be before the end time.");
    }
    await assertNoRawPunchEvidenceOnMovedDates(transaction, employee.id, requester.timeZone, [
      { label: "IN", previous: originalStart, next: effectiveStart },
      { label: "OUT", previous: originalEnd, next: effectiveEnd },
    ]);
    if (
      session
      && parsed.requestedMode === session.mode
      && parsed.requestedValues.firstIn === undefined
      && parsed.requestedValues.lastOut === undefined
    ) {
      throw new DailyAttendanceCorrectionInvalidValuesError("Provide a changed timestamp or work mode.");
    }

    const pendingRequest = await transaction.attendanceCorrectionRequest.findFirst({
      where: {
        employeeId: actor.id,
        status: AttendanceCorrectionStatus.PENDING,
        OR: [
          { attendanceDate: dateValue },
          ...(dailyAttendance ? [{ dailyAttendanceId: dailyAttendance.id }] : []),
          ...(session ? [{ sessionId: session.id }] : []),
        ],
      },
      select: { id: true },
    });
    if (pendingRequest) throw new DailyAttendanceCorrectionPendingRequestExistsError();

    const originalValues: Prisma.InputJsonObject = {
      attendanceDate: parsed.attendanceDate,
      timeZone: requester.timeZone,
      attendanceRecordId: attendanceRecord?.id ?? null,
      dailyAttendance: dailyAttendance
        ? {
            id: dailyAttendance.id,
            firstIn: dailyAttendance.firstIn?.toISOString() ?? null,
            lastOut: dailyAttendance.lastOut?.toISOString() ?? null,
            status: dailyAttendance.status,
          }
        : null,
      session: session
        ? {
            id: session.id,
            recordId: session.recordId,
            mode: session.mode,
            startAt: session.startAt.toISOString(),
            endAt: session.endAt?.toISOString() ?? null,
          }
        : null,
    };
    const requestedValues: Prisma.InputJsonObject = {
      ...(parsed.requestedValues.firstIn !== undefined
        ? { firstIn: parsed.requestedValues.firstIn }
        : {}),
      ...(parsed.requestedValues.lastOut !== undefined
        ? { lastOut: parsed.requestedValues.lastOut }
        : {}),
      requestedMode: parsed.requestedMode,
    };
    const correctionRequest = await transaction.attendanceCorrectionRequest.create({
      data: {
        employeeId: actor.id,
        requesterId: requester.id,
        attendanceDate: dateValue,
        dailyAttendanceId: dailyAttendance?.id ?? null,
        sessionId: session?.id ?? null,
        reason: parsed.reason,
        status: AttendanceCorrectionStatus.PENDING,
        currentApprovalStage: AttendanceCorrectionApprovalStage.SUPERVISOR,
        originalMode: session?.mode ?? null,
        requestedMode: parsed.requestedMode,
        originalStartAt: session?.startAt ?? null,
        originalEndAt: session?.endAt ?? null,
        originalValues,
        requestedValues,
      },
    });
    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: actor.id,
        ...(session ? { sessionId: session.id } : {}),
        actorId: requester.id,
        correctionRequestId: correctionRequest.id,
        actionType: "ATTENDANCE_CORRECTION_REQUESTED",
        previousValues: originalValues,
        newValues: requestedValues,
        reason: parsed.reason,
      },
      select: { id: true },
    });
    await transaction.notification.create({
      data: {
        userId: employee.supervisor.userId,
        title: "Attendance correction pending",
        message: `An attendance correction for ${parsed.attendanceDate} is awaiting your review.`,
        type: "ATTENDANCE_CORRECTION_PENDING",
      },
      select: { id: true },
    });
    return correctionRequest;
  });
}

export async function listOwnDailyAttendanceForCorrection(
  actor: AttendanceCorrectionActor,
  database: OwnCorrectionAttendanceReadDatabase = prisma,
) {
  if (!canRequestOwnAttendanceCorrection(actor)) {
    throw new DailyAttendanceCorrectionAccessError();
  }

  return database.attendanceDaily.findMany({
    where: {
      employee: {
        userId: actor.id,
        supervisor: { user: { role: "SUPERVISOR", isActive: true } },
      },
    },
    select: {
      id: true,
      date: true,
      firstIn: true,
      lastOut: true,
      status: true,
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
  });
}

export async function listOwnAttendanceCorrectionHistory(
  actor: AttendanceCorrectionActor,
  database: OwnCorrectionHistoryDatabase = prisma,
) {
  if (!canRequestOwnAttendanceCorrection(actor)) {
    throw new DailyAttendanceCorrectionAccessError();
  }

  return database.attendanceCorrectionRequest.findMany({
    where: { employeeId: actor.id },
    select: {
      id: true,
      attendanceDate: true,
      dailyAttendanceId: true,
      status: true,
      reason: true,
      requestedValues: true,
      decisionNote: true,
      resolutionReason: true,
      requestedAt: true,
      reviewedAt: true,
      resolvedAt: true,
      sessionId: true,
      originalMode: true,
      requestedMode: true,
      reviewedBy: { select: { name: true } },
      dailyAttendance: { select: { date: true } },
      session: { select: { startAt: true } },
    },
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
  });
}

export async function listOwnAttendanceSessionsForCorrection(
  actor: AttendanceCorrectionActor,
  database: OwnCorrectionSessionReadDatabase = prisma,
) {
  if (!canRequestOwnAttendanceCorrection(actor)) {
    throw new DailyAttendanceCorrectionAccessError();
  }

  return database.workSession.findMany({
    where: {
      record: {
        employeeId: actor.id,
        employee: {
          employee: {
            supervisor: { user: { role: "SUPERVISOR", isActive: true } },
          },
        },
      },
    },
    select: { id: true, mode: true, startAt: true, endAt: true },
    orderBy: [{ startAt: "desc" }, { id: "desc" }],
    take: 100,
  });
}

function originalAttendanceSnapshot(
  attendance: {
    employeeId: string;
    date: Date;
    shiftId: string | null;
    firstIn: Date | null;
    lastOut: Date | null;
    workingHours: Prisma.Decimal | null;
    lateMinutes: number | null;
    earlyMinutes: number | null;
    status: string | null;
    overtimeHours: Prisma.Decimal | null;
  },
): Prisma.InputJsonObject {
  return {
    employeeId: attendance.employeeId,
    date: attendance.date.toISOString(),
    shiftId: attendance.shiftId,
    firstIn: attendance.firstIn?.toISOString() ?? null,
    lastOut: attendance.lastOut?.toISOString() ?? null,
    workingHours: attendance.workingHours?.toString() ?? null,
    lateMinutes: attendance.lateMinutes,
    earlyMinutes: attendance.earlyMinutes,
    status: attendance.status,
    overtimeHours: attendance.overtimeHours?.toString() ?? null,
  };
}

async function notifyActiveHrReviewers(
  transaction: Prisma.TransactionClient,
  date: Date,
  excludedUserId?: string,
) {
  const reviewers = await transaction.user.findMany({
    where: {
      role: "HR_ADMINISTRATOR",
      isActive: true,
      ...(excludedUserId ? { id: { not: excludedUserId } } : {}),
    },
    select: { id: true },
  });
  for (const reviewer of reviewers) {
    await transaction.notification.create({
      data: {
        userId: reviewer.id,
        title: "Attendance correction pending",
        message: `An attendance correction for ${date.toISOString().slice(0, 10)} is awaiting your review.`,
        type: "ATTENDANCE_CORRECTION_PENDING",
      },
      select: { id: true },
    });
  }
}

export async function submitDailyAttendanceCorrection(
  actor: AttendanceCorrectionActor,
  dailyAttendanceId: string,
  input: unknown,
  database: AttendanceCorrectionDatabase = prisma,
) {
  if (
    !actor
    || (actor.role !== "EMPLOYEE" && actor.role !== "SUPERVISOR" && actor.role !== "HR_ADMINISTRATOR")
    || !hasPermission(actor.role, "attendance:correction:submit")
  ) {
    throw new DailyAttendanceCorrectionAccessError();
  }
  const parsed = dailyAttendanceCorrectionInputSchema.parse(input);

  return database.$transaction(async (transaction) => {
    const requester = await transaction.user.findUnique({
      where: { id: actor.id },
      select: { id: true, role: true },
    });
    if (!requester) throw new DailyAttendanceCorrectionRequesterNotFoundError();
    if (
      requester.role !== actor.role
      || (actor.role !== "EMPLOYEE" && actor.role !== "SUPERVISOR" && actor.role !== "HR_ADMINISTRATOR")
    ) {
      throw new DailyAttendanceCorrectionAccessError();
    }

    const initialAttendance = await transaction.attendanceDaily.findUnique({
      where: { id: dailyAttendanceId },
      select: {
        id: true,
        employeeId: true,
      },
    });
    if (!initialAttendance) throw new DailyAttendanceCorrectionTargetNotFoundError();

    await transaction.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${initialAttendance.employeeId} FOR UPDATE`;

    const attendance = await transaction.attendanceDaily.findUnique({
      where: { id: dailyAttendanceId },
      select: {
        id: true,
        employeeId: true,
        date: true,
        shiftId: true,
        firstIn: true,
        lastOut: true,
        workingHours: true,
        lateMinutes: true,
        earlyMinutes: true,
        status: true,
        overtimeHours: true,
        employee: {
          select: {
            id: true,
            userId: true,
            supervisor: {
              select: {
                userId: true,
                user: { select: { role: true, isActive: true } },
              },
            },
          },
        },
      },
    });
    if (!attendance) throw new DailyAttendanceCorrectionTargetNotFoundError();
    if (!attendance.employee.userId) throw new DailyAttendanceCorrectionSubjectUserNotFoundError();
    if (
      (actor.role === "EMPLOYEE" || actor.role === "HR_ADMINISTRATOR")
      && attendance.employee.userId !== actor.id
    ) {
      throw new DailyAttendanceCorrectionAccessError();
    }
    if (
      !attendance.employee.supervisor?.userId
      || attendance.employee.supervisor.user?.role !== "SUPERVISOR"
      || !attendance.employee.supervisor.user.isActive
    ) {
      throw new DailyAttendanceCorrectionReviewerNotFoundError();
    }
    if (actor.role === "SUPERVISOR" && attendance.employee.supervisor.userId !== actor.id) {
      throw new DailyAttendanceCorrectionReviewerScopeError();
    }

    const pendingRequest = await transaction.attendanceCorrectionRequest.findFirst({
      where: {
        dailyAttendanceId: attendance.id,
        status: AttendanceCorrectionStatus.PENDING,
      },
      select: { id: true },
    });
    if (pendingRequest) throw new DailyAttendanceCorrectionPendingRequestExistsError();

    const originalValues = originalAttendanceSnapshot(attendance);
    const correctionRequest = await transaction.attendanceCorrectionRequest.create({
      data: {
        employeeId: attendance.employee.userId,
        dailyAttendanceId: attendance.id,
        requesterId: requester.id,
        reason: parsed.reason,
        status: AttendanceCorrectionStatus.PENDING,
        currentApprovalStage: actor.role === "SUPERVISOR"
          ? AttendanceCorrectionApprovalStage.HR
          : AttendanceCorrectionApprovalStage.SUPERVISOR,
        originalValues,
        requestedValues: parsed.requestedValues as Prisma.InputJsonObject,
      },
    });

    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: attendance.employee.userId,
        actorId: requester.id,
        correctionRequestId: correctionRequest.id,
        actionType: "ATTENDANCE_CORRECTION_REQUESTED",
        previousValues: originalValues,
        newValues: parsed.requestedValues,
        reason: parsed.reason,
      },
      select: { id: true },
    });

    if (actor.role === "EMPLOYEE" || actor.role === "HR_ADMINISTRATOR") {
      await transaction.notification.create({
        data: {
          userId: attendance.employee.supervisor.userId,
          title: "Attendance correction pending",
          message: `An attendance correction for ${attendance.date.toISOString().slice(0, 10)} is awaiting your review.`,
          type: "ATTENDANCE_CORRECTION_PENDING",
        },
        select: { id: true },
      });
    } else {
      await notifyActiveHrReviewers(transaction, attendance.date);
    }

    return correctionRequest;
  });
}

export async function submitAttendanceSessionModeCorrection(
  actor: AttendanceCorrectionActor,
  sessionId: string,
  input: unknown,
  database: AttendanceCorrectionDatabase = prisma,
) {
  if (
    !actor
    || (actor.role !== "EMPLOYEE" && actor.role !== "HR_ADMINISTRATOR")
    || !hasPermission(actor.role, "attendance:correction:submit")
  ) {
    throw new DailyAttendanceCorrectionAccessError();
  }
  const parsed = attendanceSessionModeCorrectionInputSchema.parse(input);

  return database.$transaction(async (transaction) => {
    const requester = await transaction.user.findUnique({
      where: { id: actor.id },
      select: { id: true, role: true, isActive: true },
    });
    if (!requester || !requester.isActive) throw new DailyAttendanceCorrectionRequesterNotFoundError();
    if (requester.role !== actor.role) throw new DailyAttendanceCorrectionAccessError();

    await transaction.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.id} FOR UPDATE`;
    const session = await transaction.workSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        mode: true,
        startAt: true,
        endAt: true,
        record: {
          select: {
            employeeId: true,
            employee: {
              select: {
                employee: {
                  select: {
                    id: true,
                    supervisor: {
                      select: {
                        userId: true,
                        user: { select: { role: true, isActive: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!session) throw new DailyAttendanceCorrectionTargetNotFoundError();
    if (session.record.employeeId !== actor.id) throw new DailyAttendanceCorrectionAccessError();
    const employee = session.record.employee.employee;
    if (
      !employee?.supervisor?.userId
      || employee.supervisor.user?.role !== "SUPERVISOR"
      || !employee.supervisor.user.isActive
    ) {
      throw new DailyAttendanceCorrectionReviewerNotFoundError();
    }
    if (parsed.requestedMode === session.mode) {
      throw new z.ZodError([{
        code: "custom",
        path: ["requestedMode"],
        message: "Choose the other work mode; the session already has that mode.",
      }]);
    }

    await transaction.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${employee.id} FOR UPDATE`;
    const pendingRequest = await transaction.attendanceCorrectionRequest.findFirst({
      where: { sessionId: session.id, status: AttendanceCorrectionStatus.PENDING },
      select: { id: true },
    });
    if (pendingRequest) throw new DailyAttendanceCorrectionPendingRequestExistsError();

    const originalValues: Prisma.InputJsonObject = {
      sessionId: session.id,
      mode: session.mode,
      startAt: session.startAt.toISOString(),
      endAt: session.endAt?.toISOString() ?? null,
    };
    const requestedValues: Prisma.InputJsonObject = { requestedMode: parsed.requestedMode };
    const correctionRequest = await transaction.attendanceCorrectionRequest.create({
      data: {
        employeeId: actor.id,
        requesterId: requester.id,
        sessionId: session.id,
        reason: parsed.reason,
        status: AttendanceCorrectionStatus.PENDING,
        currentApprovalStage: AttendanceCorrectionApprovalStage.SUPERVISOR,
        originalMode: session.mode,
        requestedMode: parsed.requestedMode,
        originalStartAt: session.startAt,
        originalEndAt: session.endAt,
        originalValues,
        requestedValues,
      },
    });
    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: actor.id,
        sessionId: session.id,
        actorId: requester.id,
        correctionRequestId: correctionRequest.id,
        actionType: "ATTENDANCE_CORRECTION_REQUESTED",
        previousValues: originalValues,
        newValues: requestedValues,
        reason: parsed.reason,
      },
      select: { id: true },
    });
    await transaction.notification.create({
      data: {
        userId: employee.supervisor.userId,
        title: "Attendance correction pending",
        message: `A work-mode correction for ${session.startAt.toISOString().slice(0, 10)} is awaiting your review.`,
        type: "ATTENDANCE_CORRECTION_PENDING",
      },
      select: { id: true },
    });

    return correctionRequest;
  });
}

const correctionReviewSelect = {
  id: true,
  employeeId: true,
  requesterId: true,
  reason: true,
  status: true,
  currentApprovalStage: true,
  originalValues: true,
  requestedValues: true,
  requestedAt: true,
  attendanceDate: true,
  sessionId: true,
  originalMode: true,
  requestedMode: true,
  originalStartAt: true,
  originalEndAt: true,
  session: {
    select: {
      id: true,
      recordId: true,
      mode: true,
      startAt: true,
      endAt: true,
      record: {
        select: {
          employee: {
            select: {
              id: true,
              name: true,
              employeeCode: true,
              employee: { select: { departmentId: true } },
            },
          },
        },
      },
    },
  },
  dailyAttendance: {
    select: {
      id: true,
      employeeId: true,
      date: true,
      firstIn: true,
      lastOut: true,
      status: true,
      employee: {
        select: {
          id: true,
          name: true,
          employeeId: true,
          departmentId: true,
          supervisor: { select: { userId: true } },
        },
      },
    },
  },
  employee: {
    select: {
      id: true,
      name: true,
      employeeCode: true,
      timeZone: true,
      employee: { select: { departmentId: true, supervisor: { select: { userId: true } } } },
    },
  },
} satisfies Prisma.AttendanceCorrectionRequestSelect;

function assertCorrectionReviewer(actor: AttendanceCorrectionActor): asserts actor is Exclude<AttendanceCorrectionActor, null> {
  if (
    !actor
    || !actor.id
    || !hasPermission(actor.role, "attendance:correction:approve")
    || (actor.role !== "SUPERVISOR" && actor.role !== "HR_ADMINISTRATOR" && actor.role !== "ADMIN" && actor.role !== "DEPARTMENT_MANAGER")
  ) {
    throw new DailyAttendanceCorrectionAccessError();
  }
}

function departmentCorrectionQueueScope(departmentId: string): Prisma.AttendanceCorrectionRequestWhereInput {
  return {
    OR: [
      {
        attendanceDate: { not: null },
        requestedMode: { not: null },
        employee: { employee: { departmentId } },
      },
      {
        attendanceDate: null,
        sessionId: { not: null },
        session: { record: { employee: { employee: { departmentId } } } },
      },
      {
        attendanceDate: null,
        sessionId: null,
        dailyAttendance: { employee: { departmentId } },
      },
    ],
  };
}

async function loadAttendanceDateState(
          transaction: Prisma.TransactionClient,
          employeeUserId: string,
          employeeRecordId: string,
          date: string,
          timeZone: string,
        ) {
          const { startAt, endAt } = getEmployeeLocalDayWindow(
            fromZonedTime(`${date}T12:00:00.000`, timeZone),
            timeZone,
          );
          const dateValue = new Date(`${date}T00:00:00.000Z`);
          const [dailyRows, sessions, punches, records] = await Promise.all([
            transaction.attendanceDaily.findMany({
              where: { employeeId: employeeRecordId, date: dateValue },
              select: { id: true, employeeId: true, date: true, firstIn: true, lastOut: true, status: true },
              take: 2,
            }),
            transaction.workSession.findMany({
              where: {
                record: { employeeId: employeeUserId },
                OR: [
                  { startAt: { gte: startAt, lt: endAt } },
                  { endAt: { gte: startAt, lt: endAt } },
                ],
              },
              select: { id: true, recordId: true, mode: true, startAt: true, endAt: true },
              orderBy: [{ startAt: "asc" }, { id: "asc" }],
              take: 2,
            }),
            transaction.attendanceRaw.findMany({
              where: { employeeId: employeeRecordId, timestamp: { gte: startAt, lt: endAt } },
              select: { id: true, timestamp: true, punchType: true, workMode: true },
              orderBy: [{ timestamp: "asc" }, { id: "asc" }],
            }),
            transaction.attendanceRecord.findMany({
              where: { employeeId: employeeUserId, workDate: dateValue },
              select: { id: true, sessions: { select: { id: true } } },
              take: 2,
            }),
          ]);
          if (dailyRows.length > 1 || sessions.length > 1 || records.length > 1) {
            throw new DailyAttendanceCorrectionConflictError();
          }
          return {
            dateValue,
            startAt,
            endAt,
            daily: dailyRows[0] ?? null,
            session: sessions[0] ?? null,
            punches,
            record: records[0] ?? null,
          };
        }

        function assertAttendanceDateSnapshotMatchesState(
          snapshot: AttendanceDateCorrectionSnapshot,
          state: Awaited<ReturnType<typeof loadAttendanceDateState>>,
          requested: z.infer<typeof attendanceDateCorrectionValuesSchema>,
        ) {
          const originalSession = snapshot.session;
          const currentEndAt = state.session?.endAt?.toISOString() ?? null;
          const sessionEndMatches = originalSession?.endAt === currentEndAt
            || (
              originalSession?.endAt === null
              && state.session?.endAt !== null
              && state.session?.endAt !== undefined
              && requested.lastOut === undefined
            );
          const sessionMatches = originalSession === null
            ? state.session === null
            : state.session?.id === originalSession.id
              && state.session.recordId === originalSession.recordId
              && state.session.mode === originalSession.mode
              && state.session.startAt.toISOString() === originalSession.startAt
              && sessionEndMatches;
          const laterOutMatchesDaily = Boolean(
            originalSession
            && state.session
            && originalSession.endAt === null
            && state.session.endAt !== null
            && requested.lastOut === undefined
            && (state.daily?.lastOut?.toISOString() ?? null) === (state.session.endAt?.toISOString() ?? null),
          );
          const dailyMatchesSnapshot = snapshot.dailyAttendance === null
            ? state.daily === null
            : state.daily?.id === snapshot.dailyAttendance.id
              && (state.daily.firstIn?.toISOString() ?? null) === snapshot.dailyAttendance.firstIn
              && (
                (state.daily.lastOut?.toISOString() ?? null) === snapshot.dailyAttendance.lastOut
                || laterOutMatchesDaily
              );
          const materializedDailyMatchesSession = Boolean(
            snapshot.dailyAttendance === null
            && state.daily
            && originalSession
            && state.session
            && (state.daily.firstIn?.toISOString() ?? null) === state.session.startAt.toISOString()
            && (state.daily.lastOut?.toISOString() ?? null) === (state.session.endAt?.toISOString() ?? null),
          );
          const recordMatchesSnapshot = (state.record?.id ?? null) === snapshot.attendanceRecordId
            || (
              snapshot.attendanceRecordId === null
              && originalSession !== null
              && state.record?.id === originalSession.recordId
            );

          if (
            (!dailyMatchesSnapshot && !materializedDailyMatchesSession)
            || !sessionMatches
            || !recordMatchesSnapshot
            || (!state.session && Boolean(state.record?.sessions.length))
          ) {
            throw new DailyAttendanceCorrectionConflictError();
          }
        }

        async function finalizeAttendanceDateCorrection(
          transaction: Prisma.TransactionClient,
          input: {
            correctionRequestId: string;
            employeeUserId: string;
            employeeRecordId: string;
            attendanceDate: Date;
            timeZone: string;
            requested: z.infer<typeof dailyCorrectionValuesSchema>;
            requestedDateValues: z.infer<typeof attendanceDateCorrectionValuesSchema>;
            requestedMode: "OFFICE" | "WFH";
            dailyAttendanceId: string | null;
            expectedAttendanceRecordId: string | null;
            originalSession: {
              id: string;
              recordId: string;
              mode: "OFFICE" | "WFH";
              startAt: Date;
              endAt: Date | null;
            } | null;
            originalDaily: AttendanceDateCorrectionSnapshot["dailyAttendance"];
          },
        ) {
          const date = input.attendanceDate.toISOString().slice(0, 10);
          const state = await loadAttendanceDateState(
            transaction,
            input.employeeUserId,
            input.employeeRecordId,
            date,
            input.timeZone,
          );
          assertAttendanceDateSnapshotMatchesState({
            attendanceDate: date,
            timeZone: input.timeZone,
            attendanceRecordId: input.expectedAttendanceRecordId,
            dailyAttendance: input.originalDaily,
            session: input.originalSession
              ? {
                  id: input.originalSession.id,
                  recordId: input.originalSession.recordId,
                  mode: input.originalSession.mode,
                  startAt: input.originalSession.startAt.toISOString(),
                  endAt: input.originalSession.endAt?.toISOString() ?? null,
                }
              : null,
          }, state, input.requestedDateValues);
          const currentFirstIn = state.session?.startAt
            ?? state.daily?.firstIn
            ?? state.punches.find((punch) => punch.punchType === "IN")?.timestamp
            ?? null;
          const currentLastOut = state.session?.endAt
            ?? state.daily?.lastOut
            ?? [...state.punches].reverse().find((punch) => punch.punchType === "OUT")?.timestamp
            ?? null;
          await assertNoRawPunchEvidenceOnMovedDates(
            transaction,
            input.employeeRecordId,
            input.timeZone,
            [
              {
                label: "IN",
                previous: currentFirstIn,
                next: input.requestedDateValues.firstIn !== undefined
                  ? input.requestedDateValues.firstIn ? new Date(input.requestedDateValues.firstIn) : null
                  : currentFirstIn,
              },
              {
                label: "OUT",
                previous: currentLastOut,
                next: input.requestedDateValues.lastOut !== undefined
                  ? input.requestedDateValues.lastOut ? new Date(input.requestedDateValues.lastOut) : null
                  : currentLastOut,
              },
            ],
          );
          if (input.requested.firstIn === null || input.requested.lastOut === null) {
            throw new DailyAttendanceCorrectionConflictError();
          }

          const firstIn = input.requested.firstIn
            ? new Date(input.requested.firstIn)
            : state.session?.startAt
              ?? state.daily?.firstIn
              ?? state.punches.find((punch) => punch.punchType === "IN")?.timestamp
              ?? null;
          const lastOut = input.requested.lastOut
            ? new Date(input.requested.lastOut)
            : state.session?.endAt
              ?? state.daily?.lastOut
              ?? [...state.punches].reverse().find((punch) => punch.punchType === "OUT")?.timestamp
              ?? null;
          if (!firstIn) throw new DailyAttendanceCorrectionConflictError();
          if (lastOut && firstIn >= lastOut) {
            throw new DailyAttendanceCorrectionInvalidValuesError("The attendance start time must be before the end time.");
          }
          if (firstIn < state.startAt || firstIn >= state.endAt || (lastOut && (lastOut < state.startAt || lastOut >= state.endAt))) {
            throw new DailyAttendanceCorrectionInvalidValuesError(
              "Corrected times must fall within the selected employee-local attendance date supported by daily calculation.",
            );
          }

          let sessionId = state.session?.id ?? null;
          if (state.session) {
            const updated = await transaction.workSession.updateMany({
              where: {
                id: state.session.id,
                recordId: state.session.recordId,
                mode: state.session.mode,
                startAt: state.session.startAt,
                endAt: state.session.endAt,
              },
              data: {
                startAt: firstIn,
                endAt: lastOut,
                mode: input.requestedMode,
              },
            });
            if (updated.count !== 1) throw new DailyAttendanceCorrectionConflictError();
          } else {
            if (state.record?.sessions.length) {
              throw new DailyAttendanceCorrectionConflictError();
            }
            if (state.record) {
              const session = await transaction.workSession.create({
                data: {
                  recordId: state.record.id,
                  mode: input.requestedMode,
                  startAt: firstIn,
                  endAt: lastOut,
                },
                select: { id: true },
              });
              sessionId = session.id;
            } else {
              const record = await transaction.attendanceRecord.create({
                data: {
                  employeeId: input.employeeUserId,
                  workDate: state.dateValue,
                  sessions: {
                    create: { mode: input.requestedMode, startAt: firstIn, endAt: lastOut },
                  },
                },
                select: {
                  sessions: { select: { id: true }, take: 1 },
                },
              });
              sessionId = record.sessions[0]?.id ?? null;
            }
            if (!sessionId) throw new DailyAttendanceCorrectionConflictError();
          }

          const correctionValues: z.infer<typeof dailyCorrectionValuesSchema> = {
            ...(input.requested.firstIn !== undefined
              ? { firstIn: input.requested.firstIn }
              : {}),
            ...(input.requested.lastOut !== undefined
              ? { lastOut: input.requested.lastOut }
              : {}),
            ...(input.requested.lastOut === undefined
              && input.originalSession
              && input.originalSession.endAt === null
              && state.session?.endAt
              ? { lastOut: state.session.endAt.toISOString() }
              : {}),
          };
          const applied = await applyApprovedAttendanceCorrection(transaction, {
            dailyAttendanceId: state.daily?.id ?? null,
            employeeId: input.employeeRecordId,
            date,
            expectedFirstIn: state.daily?.firstIn ?? null,
            expectedLastOut: state.daily?.lastOut ?? null,
            correction: {
              ...(correctionValues.firstIn !== undefined
                ? { firstIn: correctionValues.firstIn === null ? null : new Date(correctionValues.firstIn) }
                : {}),
              ...(correctionValues.lastOut !== undefined
                ? { lastOut: correctionValues.lastOut === null ? null : new Date(correctionValues.lastOut) }
                : {}),
            },
          });
          const linked = await transaction.attendanceCorrectionRequest.updateMany({
            where: {
              id: input.correctionRequestId,
              status: AttendanceCorrectionStatus.APPROVED,
              dailyAttendanceId: input.dailyAttendanceId,
            },
            data: { dailyAttendanceId: applied.attendanceDaily.id, sessionId },
          });
          if (linked.count !== 1) throw new DailyAttendanceCorrectionConflictError();
          return {
            dailyAttendanceId: applied.attendanceDaily.id,
            sessionId,
            attendance: {
              firstIn: applied.calculation.firstIn?.toISOString() ?? null,
              lastOut: applied.calculation.lastOut?.toISOString() ?? null,
              mode: applied.calculation.mode,
              workingHours: applied.calculation.workingHours,
              lateMinutes: applied.calculation.lateMinutes,
              earlyMinutes: applied.calculation.earlyMinutes,
              status: applied.calculation.status,
            },
            session: {
              id: sessionId,
              mode: input.requestedMode,
              startAt: firstIn.toISOString(),
              endAt: lastOut?.toISOString() ?? null,
            },
          };
        }
export async function listDailyAttendanceCorrections(
  actor: AttendanceCorrectionActor,
  database: Pick<PrismaClient, "attendanceCorrectionRequest" | "employee" | "$transaction"> = prisma,
) {
  assertCorrectionReviewer(actor);
  const listForScope = async (
    queryDatabase: Pick<PrismaClient, "attendanceCorrectionRequest">,
    managerScope: Awaited<ReturnType<typeof getActiveManagerDepartmentScope>>,
  ) => {
    const where: Prisma.AttendanceCorrectionRequestWhereInput = {
      status: AttendanceCorrectionStatus.PENDING,
      currentApprovalStage: {
        in: [AttendanceCorrectionApprovalStage.SUPERVISOR, AttendanceCorrectionApprovalStage.HR],
      },
      ...(actor.role === "SUPERVISOR"
        ? {
            OR: [
              { dailyAttendance: { employee: { supervisor: { userId: actor.id } } } },
              { employee: { employee: { supervisor: { userId: actor.id } } } },
              {
                session: {
                  record: {
                    employee: {
                      employee: { supervisor: { userId: actor.id } },
                    },
                  },
                },
              },
            ],
          }
        : {}),
      ...(managerScope && !managerScope.isHrDepartment
        ? departmentCorrectionQueueScope(managerScope.departmentId)
        : {}),
    };
    return queryDatabase.attendanceCorrectionRequest.findMany({
      where,
      select: correctionReviewSelect,
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    });
  };
  if (actor.role === "DEPARTMENT_MANAGER") {
    return database.$transaction(async (transaction) => {
      const managerScope = await lockActiveManagerDepartmentScope(transaction, actor.id);
      if (!managerScope) throw new DailyAttendanceCorrectionReviewerScopeError();
      return listForScope(transaction, managerScope);
    });
  }
  return listForScope(database, null);
}

async function synchronizeDailyCorrectionSessions(
  transaction: Prisma.TransactionClient,
  input: {
    employeeUserId: string;
    date: string;
    timeZone: string;
    firstIn: Date | null | undefined;
    lastOut: Date | null | undefined;
    originalFirstIn: Date | null;
    originalLastOut: Date | null;
  },
) {
  const { startAt, endAt } = getEmployeeLocalDayWindow(
    fromZonedTime(`${input.date}T12:00:00.000`, input.timeZone),
    input.timeZone,
  );
  const sessions = await transaction.workSession.findMany({
    where: {
      record: { employeeId: input.employeeUserId },
      OR: [
        { startAt: { gte: startAt, lt: endAt } },
        { endAt: { gte: startAt, lt: endAt } },
      ],
    },
    select: { id: true, mode: true, startAt: true, endAt: true },
    orderBy: [{ startAt: "asc" }, { id: "asc" }],
  });
  const updates = new Map<string, {
    session: (typeof sessions)[number];
    data: { startAt?: Date; endAt?: Date | null };
  }>();
  if (input.firstIn !== undefined) {
    const matching = input.originalFirstIn
      ? sessions.filter(({ startAt: value }) => value.getTime() === input.originalFirstIn!.getTime())
      : [];
    if (
      matching.length > 1
      || (sessions.length > 0 && matching.length === 0)
      || (input.firstIn === null && matching.length > 0)
    ) {
      throw new DailyAttendanceCorrectionConflictError();
    }
    if (matching[0] && input.firstIn) {
      updates.set(matching[0].id, { session: matching[0], data: { startAt: input.firstIn } });
    }
  }
  if (input.lastOut !== undefined) {
    const matching = input.originalLastOut
      ? sessions.filter(({ endAt: value }) => value?.getTime() === input.originalLastOut!.getTime())
      : input.originalFirstIn
        ? sessions.filter(({ startAt: value, endAt }) =>
            value.getTime() === input.originalFirstIn!.getTime() && endAt === null)
        : [];
    if (matching.length > 1) throw new DailyAttendanceCorrectionConflictError();
    if (
      (sessions.length > 0 && matching.length === 0)
      || (
        input.lastOut === null
        && input.originalLastOut !== null
        && sessions.some(({ endAt }) => endAt !== null)
      )
    ) {
      throw new DailyAttendanceCorrectionConflictError();
    }
    if (matching[0]) {
      const existing = updates.get(matching[0].id);
      updates.set(matching[0].id, {
        session: matching[0],
        data: { ...existing?.data, endAt: input.lastOut },
      });
    }
  }
  for (const { session, data } of updates.values()) {
    const changed = await transaction.workSession.updateMany({
      where: {
        id: session.id,
        mode: session.mode,
        startAt: session.startAt,
        endAt: session.endAt,
      },
      data,
    });
    if (changed.count !== 1) throw new DailyAttendanceCorrectionConflictError();
  }
}

export async function decideDailyAttendanceCorrection(
  actor: AttendanceCorrectionActor,
  correctionRequestId: string,
  input: unknown,
  database: AttendanceCorrectionDatabase = prisma,
) {
  assertCorrectionReviewer(actor);
  const decision = dailyAttendanceCorrectionDecisionSchema.parse(input);

  return database.$transaction(async (transaction) => {
    const correction = await transaction.attendanceCorrectionRequest.findUnique({
      where: { id: correctionRequestId },
      select: {
        id: true,
        employeeId: true,
        requesterId: true,
        reason: true,
        status: true,
        currentApprovalStage: true,
        originalValues: true,
        requestedValues: true,
        attendanceDate: true,
        sessionId: true,
        originalMode: true,
        requestedMode: true,
        originalStartAt: true,
        originalEndAt: true,
        dailyAttendanceId: true,
        dailyAttendance: {
          select: {
            id: true,
            employeeId: true,
            date: true,
            firstIn: true,
            lastOut: true,
            employee: {
              select: {
                id: true,
                userId: true,
                departmentId: true,
                supervisor: { select: { userId: true } },
              },
            },
          },
        },
        session: {
          select: {
            id: true,
            recordId: true,
            mode: true,
            startAt: true,
            endAt: true,
            record: {
              select: {
                employeeId: true,
                employee: {
                  select: {
                    employee: {
                      select: {
                        id: true,
                        departmentId: true,
                        supervisor: { select: { userId: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        employee: {
          select: {
            employee: {
              select: {
                id: true,
                departmentId: true,
                supervisor: { select: { userId: true } },
              },
            },
          },
        },
        auditLogs: {
          where: { actionType: "ATTENDANCE_CORRECTION_SUPERVISOR_APPROVED" },
          select: { actorId: true },
        },
      },
    });
    if (!correction) throw new DailyAttendanceCorrectionTargetNotFoundError();
    await transaction.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${correction.employeeId} FOR UPDATE`;
    if (
      correction.status !== AttendanceCorrectionStatus.PENDING
      || (correction.currentApprovalStage !== AttendanceCorrectionApprovalStage.SUPERVISOR
        && correction.currentApprovalStage !== AttendanceCorrectionApprovalStage.HR)
    ) {
      throw new DailyAttendanceCorrectionStageError();
    }
    const isDateCorrection = Boolean(correction.attendanceDate && correction.requestedMode);
    const isSessionModeCorrection = !isDateCorrection && Boolean(correction.sessionId);
    const managerScope = actor.role === "DEPARTMENT_MANAGER"
      ? await lockActiveManagerDepartmentScope(transaction, actor.id)
      : null;
    if (actor.role === "DEPARTMENT_MANAGER" && !managerScope) {
      throw new DailyAttendanceCorrectionReviewerScopeError();
    }
    if (managerScope) {
      const targetEmployee = isDateCorrection
        ? correction.employee.employee
        : isSessionModeCorrection
          ? correction.session?.record.employee.employee
          : correction.dailyAttendance?.employee;
      if (!targetEmployee?.id || !targetEmployee.departmentId) {
        throw new DailyAttendanceCorrectionReviewerScopeError();
      }
      await lockEmployeeForApproval(transaction, targetEmployee.id);
      if (!managerScope.isHrDepartment && targetEmployee.departmentId !== managerScope.departmentId) {
        throw new DailyAttendanceCorrectionReviewerScopeError();
      }
    }
    if (
      actor.role === "SUPERVISOR"
      && (isSessionModeCorrection
        ? correction.session?.record.employee.employee?.supervisor?.userId !== actor.id
        : isDateCorrection
          ? correction.employee.employee?.supervisor?.userId !== actor.id
          : correction.dailyAttendance?.employee.supervisor?.userId !== actor.id)
    ) {
      throw new DailyAttendanceCorrectionReviewerScopeError();
    }

    if (correction.employeeId === actor.id || correction.requesterId === actor.id) {
      throw new DailyAttendanceCorrectionSelfApprovalError();
    }
    if (
      correction.currentApprovalStage === AttendanceCorrectionApprovalStage.HR
      && correction.auditLogs.some(({ actorId }) => actorId === actor.id)
    ) {
      throw new DailyAttendanceCorrectionSelfApprovalError();
    }
    if (decision.action === "APPROVE" && isSessionModeCorrection) {
      if (
        !correction.session
        || correction.session.id !== correction.sessionId
        || correction.session.record.employeeId !== correction.employeeId
        || correction.originalMode !== correction.session.mode
        || correction.requestedMode === null
        || correction.requestedMode === correction.originalMode
        || correction.originalStartAt?.getTime() !== correction.session.startAt.getTime()
      ) {
        throw new DailyAttendanceCorrectionConflictError();
      }
    } else if (
      decision.action === "APPROVE"
      && !isDateCorrection
      && !isSessionModeCorrection
      && (!correction.dailyAttendance || !correction.dailyAttendanceId)
    ) {
      throw new DailyAttendanceCorrectionTargetNotFoundError();
    }
    if (decision.action === "APPROVE" && isSessionModeCorrection && !correction.originalValues) {
      throw new DailyAttendanceCorrectionConflictError();
    }
    if (
      decision.action === "APPROVE"
      && !isSessionModeCorrection
      && !isDateCorrection
      && correction.dailyAttendance?.employee.userId !== correction.employeeId
    ) {
      throw new DailyAttendanceCorrectionConflictError();
    }
    let requested: z.infer<typeof dailyCorrectionValuesSchema> = {};
    if (decision.action === "REJECT") {
      requested = {};
    } else if (isSessionModeCorrection) {
      const modeRequest = attendanceSessionModeCorrectionInputSchema
        .pick({ requestedMode: true })
        .safeParse(correction.requestedValues);
      if (!modeRequest.success || modeRequest.data.requestedMode !== correction.requestedMode) {
        throw new DailyAttendanceCorrectionConflictError();
      }
    } else if (isDateCorrection) {
      const dateValues = attendanceDateCorrectionValuesSchema.safeParse(correction.requestedValues);
      const snapshot = attendanceDateCorrectionSnapshotSchema.safeParse(correction.originalValues);
      if (
        !dateValues.success
        || !snapshot.success
        || !correction.attendanceDate
        || snapshot.data.attendanceDate !== correction.attendanceDate.toISOString().slice(0, 10)
        || dateValues.data.requestedMode !== correction.requestedMode
        || !correction.employee.employee
      ) {
        throw new DailyAttendanceCorrectionConflictError();
      }
      if (dateValues.data.firstIn === null || dateValues.data.lastOut === null) {
        throw new DailyAttendanceCorrectionConflictError();
      }
      await transaction.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${correction.employeeId} FOR UPDATE`;
      await transaction.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${correction.employee.employee.id} FOR UPDATE`;
      const owner = await transaction.user.findUnique({
        where: { id: correction.employeeId },
        select: { timeZone: true },
      });
      if (!owner || owner.timeZone !== snapshot.data.timeZone) {
        throw new DailyAttendanceCorrectionConflictError();
      }
      const state = await loadAttendanceDateState(
        transaction,
        correction.employeeId,
        correction.employee.employee.id,
        snapshot.data.attendanceDate,
        owner.timeZone,
      );
      assertAttendanceDateSnapshotMatchesState(snapshot.data, state, dateValues.data);
      requested = {
        ...(dateValues.data.firstIn !== undefined ? { firstIn: dateValues.data.firstIn } : {}),
        ...(dateValues.data.lastOut !== undefined ? { lastOut: dateValues.data.lastOut } : {}),
      };
    } else {
      const requestedResult = dailyCorrectionValuesSchema.safeParse(correction.requestedValues);
      if (!requestedResult.success) throw new DailyAttendanceCorrectionConflictError();
      const attendance = correction.dailyAttendance!;
      const currentValues = {
        firstIn: attendance.firstIn?.toISOString() ?? null,
        lastOut: attendance.lastOut?.toISOString() ?? null,
      };
      const original = correction.originalValues;
      if (!original || typeof original !== "object" || Array.isArray(original)) {
        throw new DailyAttendanceCorrectionConflictError();
      }
      if (original.firstIn !== currentValues.firstIn || original.lastOut !== currentValues.lastOut) {
        throw new DailyAttendanceCorrectionConflictError();
      }
      requested = requestedResult.data;
    }

    const nextStage = decision.action === "APPROVE"
      && correction.currentApprovalStage === AttendanceCorrectionApprovalStage.SUPERVISOR
      ? AttendanceCorrectionApprovalStage.HR
      : null;
    const finalApproval = decision.action === "APPROVE" && nextStage === null;
    const status = decision.action === "REJECT"
      ? AttendanceCorrectionStatus.REJECTED
      : finalApproval ? AttendanceCorrectionStatus.APPROVED : AttendanceCorrectionStatus.PENDING;
    const now = new Date();
    const decisionReason = decision.reason ?? null;
    const auditReason = decision.reason ?? correction.reason;
    const correctionValues = finalApproval && !isSessionModeCorrection
      ? {
          ...(requested.firstIn !== undefined ? { firstIn: requested.firstIn === null ? null : new Date(requested.firstIn) } : {}),
          ...(requested.lastOut !== undefined ? { lastOut: requested.lastOut === null ? null : new Date(requested.lastOut) } : {}),
        }
      : {};
    let finalizedValues: Prisma.InputJsonObject | undefined;
    let finalizedSessionId = correction.sessionId;

    const changed = await transaction.attendanceCorrectionRequest.updateMany({
      where: {
        id: correction.id,
        status: AttendanceCorrectionStatus.PENDING,
        currentApprovalStage: correction.currentApprovalStage,
        ...(actor.role === "SUPERVISOR"
          ? isSessionModeCorrection
            ? { session: { record: { employee: { employee: { supervisor: { userId: actor.id } } } } } }
            : isDateCorrection
              ? { employee: { employee: { supervisor: { userId: actor.id } } } }
              : { dailyAttendance: { employee: { supervisor: { userId: actor.id } } } }
          : {}),
        ...(managerScope && !managerScope.isHrDepartment
          ? isDateCorrection
            ? { employee: { employee: { departmentId: managerScope.departmentId } } }
            : isSessionModeCorrection
              ? { session: { record: { employee: { employee: { departmentId: managerScope.departmentId } } } } }
              : { dailyAttendance: { employee: { departmentId: managerScope.departmentId } } }
          : {}),
      },
      data: {
        status,
        currentApprovalStage: nextStage,
        reviewedById: actor.id,
        reviewedAt: now,
        ...(finalApproval || decision.action === "REJECT" ? { resolvedAt: now } : {}),
        ...(decisionReason !== null ? { decisionNote: decisionReason } : {}),
        ...(decision.action === "REJECT" ? { resolutionReason: decisionReason } : {}),
      },
    });
    if (changed.count !== 1) throw new DailyAttendanceCorrectionStageError();

    if (finalApproval) {
      if (isSessionModeCorrection) {
        await transaction.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${correction.employeeId} FOR UPDATE`;
        const updated = await transaction.workSession.updateMany({
          where: {
            id: correction.sessionId!,
            mode: correction.originalMode!,
            startAt: correction.originalStartAt!,
          },
          data: { mode: correction.requestedMode! },
        });
        if (updated.count !== 1) throw new DailyAttendanceCorrectionConflictError();
        const finalizedSession = await transaction.workSession.findUnique({
          where: { id: correction.sessionId! },
          select: { id: true, mode: true, startAt: true, endAt: true },
        });
        if (!finalizedSession || finalizedSession.mode !== correction.requestedMode) {
          throw new DailyAttendanceCorrectionConflictError();
        }
        const employeeRecordId = correction.session?.record.employee.employee?.id;
        if (!employeeRecordId) throw new DailyAttendanceCorrectionConflictError();
        const owner = await transaction.user.findUnique({
          where: { id: correction.employeeId },
          select: { timeZone: true },
        });
        if (!owner) throw new DailyAttendanceCorrectionConflictError();
        const startDate = getEmployeeLocalDayWindow(finalizedSession.startAt, owner.timeZone).date;
        const dates = new Set([
          startDate,
          ...(finalizedSession.endAt
            ? [getEmployeeLocalDayWindow(finalizedSession.endAt, owner.timeZone).date]
            : []),
        ]);
        let recalculated: Awaited<ReturnType<typeof calculateAndPersistDailyAttendanceInTransaction>> | null = null;
        for (const date of dates) {
          const result = await calculateAndPersistDailyAttendanceInTransaction(
            transaction,
            employeeRecordId,
            date,
          );
          if (date === startDate) {
            recalculated = result;
          }
        }
        if (!recalculated) throw new DailyAttendanceCorrectionConflictError();
        const linked = await transaction.attendanceCorrectionRequest.updateMany({
          where: { id: correction.id, status: AttendanceCorrectionStatus.APPROVED },
          data: { dailyAttendanceId: recalculated.attendanceDaily.id },
        });
        if (linked.count !== 1) throw new DailyAttendanceCorrectionConflictError();
        finalizedValues = {
          session: {
            sessionId: finalizedSession.id,
            mode: finalizedSession.mode,
            startAt: finalizedSession.startAt.toISOString(),
            endAt: finalizedSession.endAt?.toISOString() ?? null,
          },
          attendance: {
            firstIn: recalculated.calculation.firstIn?.toISOString() ?? null,
            lastOut: recalculated.calculation.lastOut?.toISOString() ?? null,
            mode: recalculated.calculation.mode,
          },
        };
      } else if (isDateCorrection) {
        const dateSnapshot = attendanceDateCorrectionSnapshotSchema.safeParse(correction.originalValues);
        const employee = correction.employee.employee;
        if (!correction.attendanceDate || !dateSnapshot.success || !employee) {
          throw new DailyAttendanceCorrectionConflictError();
        }
        const owner = await transaction.user.findUnique({
          where: { id: correction.employeeId },
          select: { timeZone: true },
        });
        if (!owner) throw new DailyAttendanceCorrectionConflictError();
        try {
          const applied = await finalizeAttendanceDateCorrection(transaction, {
            correctionRequestId: correction.id,
            employeeUserId: correction.employeeId,
            employeeRecordId: employee.id,
            attendanceDate: correction.attendanceDate,
            timeZone: owner.timeZone,
            requested,
            requestedDateValues: attendanceDateCorrectionValuesSchema.parse(correction.requestedValues),
            requestedMode: correction.requestedMode as "OFFICE" | "WFH",
            dailyAttendanceId: correction.dailyAttendanceId,
            expectedAttendanceRecordId: dateSnapshot.data.attendanceRecordId,
            originalSession: dateSnapshot.data.session
              ? {
                  id: dateSnapshot.data.session.id,
                  recordId: dateSnapshot.data.session.recordId,
                  mode: dateSnapshot.data.session.mode,
                  startAt: new Date(dateSnapshot.data.session.startAt),
                  endAt: dateSnapshot.data.session.endAt
                    ? new Date(dateSnapshot.data.session.endAt)
                    : null,
                }
              : null,
            originalDaily: dateSnapshot.data.dailyAttendance,
          });
            await recalculateAttendanceMonthsFromDatesInTransaction(transaction, {
              employeeRecordId: employee.id,
              employeeUserId: correction.employeeId,
              timeZone: owner.timeZone,
              affectedDates: [correction.attendanceDate.toISOString().slice(0, 10)],
              excludeDates: [correction.attendanceDate.toISOString().slice(0, 10)],
            });
          finalizedValues = {
            attendanceDate: correction.attendanceDate.toISOString().slice(0, 10),
            attendance: applied.attendance,
            session: applied.session,
          };
          finalizedSessionId = applied.sessionId;
        } catch (error) {
          if (error instanceof AttendanceCorrectionEngineConflictError) {
            throw new DailyAttendanceCorrectionConflictError();
          }
          throw error;
        }
      } else {
        const attendance = correction.dailyAttendance;
        if (!attendance || !correction.dailyAttendanceId) {
          throw new DailyAttendanceCorrectionTargetNotFoundError();
        }
        try {
        const owner = await transaction.user.findUnique({
          where: { id: correction.employeeId },
          select: { timeZone: true },
        });
        if (!owner) throw new DailyAttendanceCorrectionConflictError();
        await synchronizeDailyCorrectionSessions(transaction, {
          employeeUserId: correction.employeeId,
          date: attendance.date.toISOString().slice(0, 10),
          timeZone: owner.timeZone,
          firstIn: requested.firstIn === undefined
            ? undefined
            : requested.firstIn === null
              ? null
              : new Date(requested.firstIn),
          lastOut: requested.lastOut === undefined
            ? undefined
            : requested.lastOut === null
              ? null
              : new Date(requested.lastOut),
          originalFirstIn: attendance.firstIn,
          originalLastOut: attendance.lastOut,
        });
        const applied = await applyApprovedAttendanceCorrection(transaction, {
          dailyAttendanceId: correction.dailyAttendanceId,
          employeeId: attendance.employee.id,
          date: attendance.date.toISOString().slice(0, 10),
          expectedFirstIn: attendance.firstIn,
          expectedLastOut: attendance.lastOut,
          correction: correctionValues,
        });
        if (requested.firstIn !== undefined) {
          await recalculateAttendanceMonthsFromDatesInTransaction(transaction, {
            employeeRecordId: attendance.employee.id,
            employeeUserId: correction.employeeId,
            timeZone: owner.timeZone,
            affectedDates: [attendance.date.toISOString().slice(0, 10)],
            excludeDates: [attendance.date.toISOString().slice(0, 10)],
          });
        }
        const calculation = applied.calculation;
        finalizedValues = {
          firstIn: calculation.firstIn?.toISOString() ?? null,
          lastOut: calculation.lastOut?.toISOString() ?? null,
          workingHours: calculation.workingHours,
          lateMinutes: calculation.lateMinutes,
          earlyMinutes: calculation.earlyMinutes,
          status: calculation.status,
        };
        } catch (error) {
          if (error instanceof AttendanceCorrectionEngineConflictError) {
            throw new DailyAttendanceCorrectionConflictError();
          }
          throw error;
        }
      }
    }

    const actionType = decision.action === "REJECT"
      ? "ATTENDANCE_CORRECTION_REJECTED"
      : correction.currentApprovalStage === AttendanceCorrectionApprovalStage.SUPERVISOR
        ? "ATTENDANCE_CORRECTION_SUPERVISOR_APPROVED"
        : "ATTENDANCE_CORRECTION_HR_APPROVED";
    const auditNewValues: Prisma.InputJsonObject = {
      status,
      currentApprovalStage: nextStage,
      actorRole: actor.role,
      ...(finalizedValues
        ? isSessionModeCorrection
          ? finalizedValues
          : isDateCorrection
            ? finalizedValues
            : { attendance: finalizedValues }
        : {}),
    };
    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: correction.employeeId,
        ...(isSessionModeCorrection || isDateCorrection
          ? { sessionId: finalizedSessionId }
          : {}),
        actorId: actor.id,
        correctionRequestId: correction.id,
        actionType,
        previousValues: {
          status: correction.status,
          currentApprovalStage: correction.currentApprovalStage,
          ...(isSessionModeCorrection
            ? { session: correction.originalValues }
            : { attendance: correction.originalValues }),
        },
        newValues: auditNewValues,
        reason: auditReason,
      },
      select: { id: true },
    });

    if (nextStage === AttendanceCorrectionApprovalStage.HR) {
      const correctionDate = correction.attendanceDate ?? correction.dailyAttendance?.date ?? correction.session?.startAt;
      if (!correctionDate) throw new DailyAttendanceCorrectionTargetNotFoundError();
      await notifyActiveHrReviewers(transaction, correctionDate, correction.employeeId);
    } else {
      const outcome = status === AttendanceCorrectionStatus.APPROVED ? "approved" : "rejected";
      await transaction.notification.create({
        data: {
          userId: correction.employeeId,
          title: `Attendance correction ${outcome}`,
          message: `Your attendance correction was ${outcome}.`,
          type: status === AttendanceCorrectionStatus.APPROVED
            ? "ATTENDANCE_CORRECTION_APPROVED"
            : "ATTENDANCE_CORRECTION_REJECTED",
        },
        select: { id: true },
      });
    }

    return { id: correction.id, status, currentApprovalStage: nextStage };
  });
}
