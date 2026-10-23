import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role } from "@prisma/client";
import {
  enqueueDailyAttendanceCalculation,
  runAttendanceReconciliationWorker,
} from "./daily-reconciliation-queue";

type Task = {
  id: string;
  employeeId: string;
  attendanceDate: Date;
  timeZone: string;
  lastPunchId: string;
  requestedVersion: number;
};

function createEnqueueTransaction() {
  const tasks = new Map<string, Task>();
  const events = new Set<string>();
  const transaction = {
    attendanceDailyCalculationTask: {
      findUnique: async ({ where }: { where: { employeeId_attendanceDate: { employeeId: string; attendanceDate: Date } } }) =>
        tasks.get(`${where.employeeId_attendanceDate.employeeId}:${where.employeeId_attendanceDate.attendanceDate.toISOString()}`) ?? null,
      create: async ({ data }: { data: Omit<Task, "id" | "requestedVersion"> }) => {
        const key = `${data.employeeId}:${data.attendanceDate.toISOString()}`;
        const task = { ...data, id: `task-${tasks.size + 1}`, requestedVersion: 1 };
        tasks.set(key, task);
        return task;
      },
      update: async ({ where, data }: {
        where: { id: string };
        data: { timeZone: string; lastPunchId: string; requestedVersion: { increment: number } };
      }) => {
        const entry = [...tasks.entries()].find(([, task]) => task.id === where.id);
        if (!entry) throw new Error("Task is missing.");
        const [key, current] = entry;
        const task = {
          ...current,
          timeZone: data.timeZone,
          lastPunchId: data.lastPunchId,
          requestedVersion: current.requestedVersion + data.requestedVersion.increment,
        };
        tasks.set(key, task);
        return task;
      },
    },
    attendanceDailyCalculationTaskEvent: {
      createMany: async ({ data }: { data: Array<{ taskId: string; punchId: string }> }) => {
        let count = 0;
        for (const event of data) {
          const key = `${event.taskId}:${event.punchId}`;
          if (!events.has(key)) {
            events.add(key);
            count += 1;
          }
        }
        return { count };
      },
    },
  };
  return { transaction: transaction as never, tasks, events };
}

const configuredShift = {
  id: "shift-1",
  startTime: new Date("1970-01-01T08:30:00.000Z"),
  endTime: new Date("1970-01-01T17:30:00.000Z"),
  gracePeriodMinutes: 0,
  lateThresholdMinutes: 0,
  earlyDepartureThresholdMinutes: 0,
  breakDurationMinutes: 0,
  minimumWorkingHours: "8",
  overtimeEligible: false,
  roundingRules: null,
  workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
};

function createWorkerDatabase(options: {
  userId?: string | null;
  isActive?: boolean;
  role?: Role;
  shift?: typeof configuredShift | null;
  approvedCorrection?: boolean;
} = {}) {
  const task = {
    id: "task-1",
    employeeId: "employee-1",
    attendanceDate: new Date("2026-06-15T00:00:00.000Z"),
    timeZone: "UTC",
    lastPunchId: "punch-1",
    requestedVersion: 1,
    completedVersion: 0,
    claimedVersion: null as number | null,
    status: "PENDING",
    attempts: 0,
    availableAt: new Date("2026-06-15T00:00:00.000Z"),
    leaseToken: null as string | null,
    leaseExpiresAt: null as Date | null,
    lastErrorCategory: null as string | null,
  };
  const dailyRows: Array<Record<string, unknown> & { id: string; date: Date; employeeId: string }> = [];
  if (options.approvedCorrection) {
    dailyRows.push({
      id: "corrected-daily",
      date: task.attendanceDate,
      employeeId: task.employeeId,
      status: "CORRECTED",
    });
  }
  const lockOrder: string[] = [];
  let nextDailyId = 1;
  const employee = {
    id: "employee-1",
    userId: options.userId === undefined ? "user-1" : options.userId,
    user: options.userId === null ? null : {
      id: options.userId ?? "user-1",
      role: options.role ?? Role.EMPLOYEE,
      isActive: options.isActive ?? true,
      timeZone: "UTC",
      countryCode: "LK",
    },
    shift: options.shift === undefined ? configuredShift : options.shift,
    shiftAssignments: [],
  };
  const database = {
    $transaction: async (callback: (transaction: never) => Promise<unknown>) => callback({
      $queryRaw: async (strings: TemplateStringsArray) => {
        const query = strings.join("");
        if (query.includes('FROM "attendance_daily_calculation_tasks"') && query.includes('"attendanceDate"')) {
          lockOrder.push("claim");
          return task.status === "PENDING" || task.status === "RETRY_WAIT" ? [{
            id: task.id,
            employeeId: task.employeeId,
            attendanceDate: task.attendanceDate,
            timeZone: task.timeZone,
            requestedVersion: task.requestedVersion,
            attempts: task.attempts,
          }] : [];
        }
        if (query.includes('FROM "User"')) lockOrder.push("user");
        else if (query.includes('FROM "Employee"')) lockOrder.push("employee");
        else if (query.includes('FROM "attendance_daily_calculation_tasks"')) lockOrder.push("task");
        return [];
      },
      attendanceDailyCalculationTask: {
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          if (where.status === "PROCESSING" && where.leaseExpiresAt) return { count: 0 };
          if (where.status === "PROCESSING" && where.leaseToken === task.leaseToken) {
            Object.assign(task, data);
            return { count: 1 };
          }
          return { count: 0 };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          const attemptUpdate = data.attempts;
          const increment = typeof attemptUpdate === "object"
            && attemptUpdate !== null
            && "increment" in attemptUpdate
            && typeof attemptUpdate.increment === "number"
            ? attemptUpdate.increment
            : 0;
          Object.assign(task, { ...data, attempts: task.attempts + increment });
          return { attempts: task.attempts };
        },
        findUnique: async () => task,
        count: async () => task.status === "PENDING" || task.status === "RETRY_WAIT" ? 1 : 0,
      },
      employee: { findUnique: async () => employee },
      attendanceRaw: { findMany: async () => [] },
      holiday: { findFirst: async () => null },
      attendanceDaily: {
        findMany: async () => dailyRows.map((row) => ({
          id: row.id,
          correctionRequests: options.approvedCorrection ? [{ id: "approved-correction" }] : [],
        })),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `daily-${nextDailyId++}`, ...data } as typeof dailyRows[number];
          dailyRows.push(row);
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = dailyRows.find((item) => item.id === where.id);
          if (!row) throw new Error("Expected daily row to exist.");
          Object.assign(row, data);
          return row;
        },
      },
    } as never),
  };
  return { database: database as never, task, dailyRows, lockOrder };
}

describe("daily attendance reconciliation", () => {
  it("coalesces an employee/local date into one versioned task and deduplicates the same punch", async () => {
    const { transaction, tasks } = createEnqueueTransaction();
    const input = {
      employeeId: "employee-record",
      attendanceDate: "2026-06-15",
      timeZone: "America/Los_Angeles",
      punchId: "punch-1",
    };

    await enqueueDailyAttendanceCalculation(transaction, input);
    await enqueueDailyAttendanceCalculation(transaction, input);
    assert.equal(tasks.size, 1);
    assert.equal([...tasks.values()][0].requestedVersion, 1);

    await enqueueDailyAttendanceCalculation(transaction, { ...input, punchId: "punch-2" });
    const task = [...tasks.values()][0];
    assert.equal(tasks.size, 1);
    assert.equal(task.requestedVersion, 2);
    assert.equal(task.lastPunchId, "punch-2");

    await enqueueDailyAttendanceCalculation(transaction, input);
    assert.equal(task.requestedVersion, 2);
    assert.equal(task.lastPunchId, "punch-2");
  });

  it("keeps different employee-local dates independent", async () => {
    const { transaction, tasks } = createEnqueueTransaction();

    await enqueueDailyAttendanceCalculation(transaction, {
      employeeId: "employee-record",
      attendanceDate: "2026-06-15",
      timeZone: "UTC",
      punchId: "punch-1",
    });
    await enqueueDailyAttendanceCalculation(transaction, {
      employeeId: "employee-record",
      attendanceDate: "2026-06-16",
      timeZone: "UTC",
      punchId: "punch-2",
    });

    assert.equal(tasks.size, 2);
    assert.deepEqual([...tasks.values()].map(({ requestedVersion }) => requestedVersion), [1, 1]);
  });

  it("atomically completes the calculated version after acquiring User, Employee, then task locks", async () => {
    const harness = createWorkerDatabase();

    const summary = await runAttendanceReconciliationWorker(new Date("2026-06-15T12:00:00.000Z"), harness.database);

    assert.equal(summary.claimed, 1);
    assert.equal(summary.pending, 0);
    assert.equal(summary.calculated, 1);
    assert.equal(harness.task.status, "COMPLETED");
    assert.equal(harness.task.completedVersion, harness.task.requestedVersion);
    assert.equal(harness.dailyRows.length, 1);
    assert.deepEqual(harness.lockOrder.slice(0, 4), ["claim", "user", "employee", "task"]);
  });

  it("protects approved corrections and skips inactive or unlinked identities", async () => {
    const corrected = createWorkerDatabase({ approvedCorrection: true });
    const inactive = createWorkerDatabase({ isActive: false });
    const unlinked = createWorkerDatabase({ userId: null });

    const protectedSummary = await runAttendanceReconciliationWorker(new Date("2026-06-15T12:00:00.000Z"), corrected.database);
    const inactiveSummary = await runAttendanceReconciliationWorker(new Date("2026-06-15T12:00:00.000Z"), inactive.database);
    const unlinkedSummary = await runAttendanceReconciliationWorker(new Date("2026-06-15T12:00:00.000Z"), unlinked.database);

    assert.equal(protectedSummary.protected, 1);
    assert.equal(corrected.task.status, "PROTECTED");
    assert.equal(corrected.dailyRows[0].status, "CORRECTED");
    assert.equal(inactiveSummary.skippedInactive, 1);
    assert.equal(inactive.dailyRows.length, 0);
    assert.equal(unlinkedSummary.unlinkedEmployees, 1);
    assert.equal(unlinked.dailyRows.length, 0);
  });

  it("records a bounded retry without replacing the committed task", async () => {
    const harness = createWorkerDatabase({ shift: null });

    const summary = await runAttendanceReconciliationWorker(new Date("2026-06-15T12:00:00.000Z"), harness.database);

    assert.equal(summary.retried, 1);
    assert.deepEqual(summary.failureCategories, { AttendanceEngineConfigurationError: 1 });
    assert.equal(harness.task.status, "RETRY_WAIT");
    assert.equal(harness.task.attempts, 1);
  });
});
