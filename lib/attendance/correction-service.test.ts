import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AttendanceCorrectionApprovalStage,
  AttendanceCorrectionStatus,
  Role,
} from "@prisma/client";
import {
  DailyAttendanceCorrectionAccessError,
  DailyAttendanceCorrectionConflictError,
  DailyAttendanceCorrectionPendingRequestExistsError,
  DailyAttendanceCorrectionRequesterNotFoundError,
  DailyAttendanceCorrectionReviewerNotFoundError,
  DailyAttendanceCorrectionSelfApprovalError,
  DailyAttendanceCorrectionReviewerScopeError,
  DailyAttendanceCorrectionSubjectUserNotFoundError,
  DailyAttendanceCorrectionStageError,
  DailyAttendanceCorrectionTargetNotFoundError,
  decideDailyAttendanceCorrection,
  attendanceSessionModeCorrectionInputSchema,
  dailyAttendanceCorrectionInputSchema,
  listOwnAttendanceCorrectionHistory,
  listOwnDailyAttendanceForCorrection,
  listDailyAttendanceCorrections,
  listOwnAttendanceSessionsForCorrection,
  submitAttendanceDateCorrection,
  submitAttendanceSessionModeCorrection,
  submitDailyAttendanceCorrection,
} from "./correction-service";

const employeeActor = { id: "user-1", role: Role.EMPLOYEE };
const supervisorActor = { id: "supervisor-user", role: Role.SUPERVISOR };
const adminActor = { id: "admin-user", role: Role.ADMIN };
type TestDaily = {
  id: string;
  employeeId: string;
  date: Date;
  shiftId: string | null;
  firstIn: Date | null;
  lastOut: Date | null;
  workingHours: number | null;
  lateMinutes: number | null;
  earlyMinutes: number | null;
  status: string | null;
  overtimeHours: number | null;
  employee: {
    id: string;
    userId: string | null;
    departmentId: string;
    supervisor: { userId: string | null; user: { role: Role; isActive: boolean } | null } | null;
  };
};

const originalDaily: TestDaily = {
  id: "daily-1",
  employeeId: "employee-1",
  date: new Date("2026-10-05T00:00:00.000Z"),
  shiftId: "shift-1",
  firstIn: new Date("2026-10-05T03:00:00.000Z"),
  lastOut: null,
  workingHours: null,
  lateMinutes: 0,
  earlyMinutes: null,
  status: "MISSING_PUNCH",
  overtimeHours: null,
  employee: {
    id: "employee-1",
    userId: "user-1",
    departmentId: "engineering-dept",
    supervisor: { userId: "supervisor-user", user: { role: Role.SUPERVISOR, isActive: true } },
  },
};

function createDatabase(options: {
  daily?: TestDaily | null;
  requesterExists?: boolean;
  supervisorUserId?: string | null;
  failDailyUpdate?: boolean;
  changeSupervisorBeforeConditionalUpdate?: boolean;
  managerDepartmentId?: string | null;
  managerDepartmentName?: string;
  employeeDepartmentId?: string;
  session?: {
    id: string;
    mode: "OFFICE" | "WFH";
    startAt: Date;
    endAt: Date | null;
    employeeId: string;
  } | null;
} = {}) {
  const sourceDaily = options.daily === undefined ? originalDaily : options.daily;
  const daily = sourceDaily ? structuredClone(sourceDaily) : null;
  if (daily && options.employeeDepartmentId) daily.employee.departmentId = options.employeeDepartmentId;
  const dailyBefore = daily ? structuredClone(daily) : null;
  const session = options.session === undefined
    ? {
        id: "session-1",
        mode: "OFFICE" as const,
        startAt: new Date("2026-10-05T03:00:00.000Z"),
        endAt: null,
        employeeId: "user-1",
      }
    : options.session ? structuredClone(options.session) : null;
  const rawPunches = [
    ...(daily?.firstIn ? [{ id: "raw-in", timestamp: daily.firstIn, punchType: "IN" as const }] : []),
    ...(daily?.lastOut ? [{ id: "raw-out", timestamp: daily.lastOut, punchType: "OUT" as const }] : []),
  ];
  const rawBefore = structuredClone(rawPunches);
  const requests: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];
  const rawMutations: string[] = [];
  const correctionQueries: unknown[] = [];
  const historyQueries: unknown[] = [];
  const users = new Set(options.requesterExists === false ? [] : ["user-1", "subject-user", "supervisor-user", "hr-user", "admin-user", "other-supervisor"]);
  const roles = new Map([
    ["user-1", Role.EMPLOYEE],
    ["subject-user", Role.EMPLOYEE],
    ["supervisor-user", Role.SUPERVISOR],
    ["hr-user", Role.HR_ADMINISTRATOR],
    ["admin-user", Role.ADMIN],
    ["other-supervisor", Role.SUPERVISOR],
  ]);
  let nextId = 1;

  const transaction = {
    $queryRaw: async () => [],
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => users.has(where.id)
        ? { id: where.id, role: roles.get(where.id), isActive: true }
        : null,
      findMany: async ({ where }: { where: { role: Role; isActive: boolean } }) => [...users]
        .filter((id) => roles.get(id) === where.role)
        .map((id) => ({ id })),
    },
    employee: {
      findUnique: async ({ where }: { where: { id?: string; userId?: string } }) => where.userId === "department-manager"
        ? {
            id: "manager-employee",
            departmentId: options.managerDepartmentId === undefined ? "engineering-dept" : options.managerDepartmentId,
            department: { name: options.managerDepartmentName ?? "Engineering" },
            user: { role: Role.DEPARTMENT_MANAGER, isActive: true },
          }
        : daily && where.id === daily.employee.id ? ({
        id: where.id,
        departmentId: daily.employee.departmentId,
        user: { timeZone: "Asia/Colombo" },
        shift: {
          id: "shift-1",
          startTime: new Date("1970-01-01T08:30:00.000Z"),
          endTime: new Date("1970-01-01T17:30:00.000Z"),
          gracePeriodMinutes: 10,
          lateThresholdMinutes: 0,
          earlyDepartureThresholdMinutes: 0,
          breakDurationMinutes: 0,
          minimumWorkingHours: "8",
          overtimeEligible: false,
          roundingRules: null,
          workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
        },
      }) : null,
    },
    workSession: {
      findMany: async () => session && session.employeeId === "user-1"
        ? [{ id: session.id, mode: session.mode, startAt: session.startAt, endAt: session.endAt }]
        : [],
      findUnique: async ({ where }: { where: { id: string } }) => session?.id === where.id ? ({
        id: session.id,
        mode: session.mode,
        startAt: session.startAt,
        endAt: session.endAt,
        record: {
          employeeId: session.employeeId,
          employee: {
            employee: {
              id: "employee-1",
              departmentId: options.employeeDepartmentId ?? daily?.employee.departmentId ?? "engineering-dept",
              supervisor: {
                userId: options.supervisorUserId === undefined ? "supervisor-user" : options.supervisorUserId,
                user: { role: Role.SUPERVISOR, isActive: true },
              },
            },
          },
        },
      }) : null,
      updateMany: async ({ where, data }: {
        where: { id: string; mode: "OFFICE" | "WFH"; startAt: Date };
        data: { mode: "OFFICE" | "WFH" };
      }) => {
        if (
          !session
          || session.id !== where.id
          || session.mode !== where.mode
          || session.startAt.getTime() !== where.startAt.getTime()
        ) return { count: 0 };
        session.mode = data.mode;
        return { count: 1 };
      },
    },
    attendanceDaily: {
      findUnique: async ({ where }: { where: { id: string } }) => daily?.id === where.id ? structuredClone(daily) : null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (!daily || daily.id !== where.id) throw new Error("missing daily attendance");
        Object.assign(daily, data);
        return structuredClone(daily);
      },
      updateMany: async ({ where, data }: { where: { id: string; firstIn?: Date | null; lastOut?: Date | null }; data: Record<string, unknown> }) => {
        if (
          options.failDailyUpdate
          || !daily
          || daily.id !== where.id
          || (where.firstIn !== undefined && daily.firstIn?.getTime() !== where.firstIn?.getTime())
          || (where.lastOut !== undefined && daily.lastOut?.getTime() !== where.lastOut?.getTime())
        ) return { count: 0 };
        Object.assign(daily, data);
        return { count: 1 };
      },
      delete: async () => { throw new Error("AttendanceDaily must not be deleted."); },
    },
    attendanceRaw: {
      findMany: async () => rawPunches,
      create: async () => { rawMutations.push("create"); throw new Error("Raw attendance must not be written."); },
      update: async () => { rawMutations.push("update"); throw new Error("Raw attendance must not be updated."); },
      delete: async () => { rawMutations.push("delete"); throw new Error("Raw attendance must not be deleted."); },
    },
    attendanceCorrectionRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const request = { id: `correction-${nextId++}`, ...data };
        requests.push(structuredClone(request));
        return request;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const request = requests.find(({ id }) => id === where.id);
        if (!request) return null;
        const requestDaily = daily && daily.id === request.dailyAttendanceId ? daily : null;
        return {
          ...structuredClone(request),
          dailyAttendance: requestDaily ? {
            id: requestDaily.id,
            employeeId: requestDaily.employeeId,
            date: requestDaily.date,
            firstIn: requestDaily.firstIn,
            lastOut: requestDaily.lastOut,
            employee: {
              id: requestDaily.employee.id,
              userId: requestDaily.employee.userId,
              departmentId: options.employeeDepartmentId ?? requestDaily.employee.departmentId,
              supervisor: options.supervisorUserId === undefined
                ? requestDaily.employee.supervisor
                : requestDaily.employee.supervisor
                  ? { userId: options.supervisorUserId }
                  : null,
            },
          } : null,
          session: session && session.id === request.sessionId ? {
            id: session.id,
            mode: session.mode,
            startAt: session.startAt,
            endAt: session.endAt,
            record: {
              employeeId: session.employeeId,
              employee: {
                employee: {
                  id: "employee-1",
                  departmentId: options.employeeDepartmentId ?? daily?.employee.departmentId ?? "engineering-dept",
                  supervisor: { userId: options.supervisorUserId ?? "supervisor-user" },
                },
              },
            },
          } : null,
          employee: {
            employee: {
              id: "employee-1",
              departmentId: options.employeeDepartmentId ?? daily?.employee.departmentId ?? "engineering-dept",
              supervisor: { userId: options.supervisorUserId ?? "supervisor-user" },
            },
          },
          auditLogs: audits
            .filter((audit) => audit.correctionRequestId === request.id && audit.actionType === "ATTENDANCE_CORRECTION_SUPERVISOR_APPROVED")
            .map((audit) => ({ actorId: audit.actorId })),
        };
      },
      findFirst: async ({ where }: { where: { dailyAttendanceId?: string; sessionId?: string; status: AttendanceCorrectionStatus } }) => {
        const request = requests.find((candidate) =>
          (where.dailyAttendanceId === undefined || candidate.dailyAttendanceId === where.dailyAttendanceId)
          && (where.sessionId === undefined || candidate.sessionId === where.sessionId)
          && candidate.status === where.status);
        return request ? { id: request.id } : null;
      },
      updateMany: async ({ where, data }: { where: { id: string; status: AttendanceCorrectionStatus; currentApprovalStage: AttendanceCorrectionApprovalStage; dailyAttendance?: { employee: { supervisor?: { userId: string }; departmentId?: string } }; employee?: { employee?: { departmentId?: string } }; session?: unknown; OR?: Array<{ dailyAttendance?: { employee: { departmentId?: string } }; employee?: { employee?: { departmentId?: string } }; session?: unknown }> }; data: Record<string, unknown> }) => {
        const request = requests.find(({ id }) => id === where.id);
        if (options.changeSupervisorBeforeConditionalUpdate) options.supervisorUserId = "other-supervisor";
        if (
          !request
          || request.status !== where.status
          || request.currentApprovalStage !== where.currentApprovalStage
          || (where.dailyAttendance?.employee.supervisor && (options.supervisorUserId ?? daily?.employee.supervisor?.userId) !== where.dailyAttendance.employee.supervisor.userId)
          || (where.session && options.supervisorUserId === "other-supervisor")
          || ((where.dailyAttendance?.employee.departmentId || where.employee?.employee?.departmentId)
            && (options.employeeDepartmentId ?? daily?.employee.departmentId ?? "engineering-dept") !== (
              where.dailyAttendance?.employee.departmentId ?? where.employee?.employee?.departmentId
            ))
          || (where.OR?.some((condition) => condition.dailyAttendance?.employee.departmentId || condition.employee?.employee?.departmentId)
            && (options.employeeDepartmentId ?? daily?.employee.departmentId ?? "engineering-dept") !== (
              where.OR.find((condition) => condition.dailyAttendance?.employee.departmentId || condition.employee?.employee?.departmentId)
                ?.dailyAttendance?.employee.departmentId
              ?? where.OR.find((condition) => condition.employee?.employee?.departmentId)?.employee?.employee?.departmentId
            ))
        ) {
          return { count: 0 };
        }
        Object.assign(request, data);
        return { count: 1 };
      },
      findMany: async ({ where }: { where: { employeeId?: string; status?: AttendanceCorrectionStatus; currentApprovalStage?: AttendanceCorrectionApprovalStage | { in: AttendanceCorrectionApprovalStage[] }; dailyAttendance?: { employee: { supervisor?: { userId: string }; departmentId?: string } }; OR?: Array<{ dailyAttendance?: { employee: { departmentId?: string; supervisor?: { userId: string } } }; employee?: { employee?: { departmentId?: string } }; session?: unknown }> } }) => {
        if (where.employeeId) {
          historyQueries.push({ employeeId: where.employeeId });
          return requests
            .filter((request) => request.employeeId === where.employeeId)
            .map((request) => ({
              ...structuredClone(request),
              reviewedBy: request.reviewedById ? { name: "Reviewer" } : null,
              dailyAttendance: daily && request.dailyAttendanceId === daily.id ? { date: daily.date } : null,
              session: session && request.sessionId === session.id ? { startAt: session.startAt } : null,
            }));
        }
        correctionQueries.push(where);
        const departmentFilter = where.OR?.find((condition) =>
          condition.dailyAttendance?.employee.departmentId || condition.employee?.employee?.departmentId,
        );
        const departmentId = departmentFilter?.dailyAttendance?.employee.departmentId
          ?? departmentFilter?.employee?.employee?.departmentId;
        return requests.filter((request) =>
          request.status === where.status
          && (where.currentApprovalStage && typeof where.currentApprovalStage === "object" && "in" in where.currentApprovalStage
            ? where.currentApprovalStage.in.includes(request.currentApprovalStage as AttendanceCorrectionApprovalStage)
            : request.currentApprovalStage === where.currentApprovalStage)
          && (!where.dailyAttendance || options.supervisorUserId !== "other-supervisor")
          && (!departmentId || (options.employeeDepartmentId ?? daily?.employee.departmentId ?? "engineering-dept") === departmentId),
        );
      },
    },
    attendanceAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(structuredClone(data));
        return { id: `audit-${audits.length}` };
      },
    },
    notification: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        notifications.push(structuredClone(data));
        return { id: `notification-${notifications.length}` };
      },
    },
  };
  const database = {
    $transaction: async <T>(operation: (tx: typeof transaction) => Promise<T>) => operation(transaction),
    attendanceCorrectionRequest: transaction.attendanceCorrectionRequest,
    employee: transaction.employee,
    workSession: transaction.workSession,
  } as never;
  return {
    database,
    requests,
    audits,
    notifications,
    rawMutations,
    rawPunches,
    rawBefore,
    daily,
    dailyBefore,
    session,
    roles,
    correctionQueries,
    historyQueries,
  };
}

describe("daily attendance correction request validation", () => {
  it("requires a non-empty JSON object of requested values and a reason", () => {
    assert.equal(dailyAttendanceCorrectionInputSchema.safeParse({
      requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
      reason: "Forgot to punch out",
    }).success, true);
    assert.equal(dailyAttendanceCorrectionInputSchema.safeParse({
      requestedValues: {},
      reason: "Correction",
    }).success, false);
    assert.equal(dailyAttendanceCorrectionInputSchema.safeParse({
      requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
      reason: "   ",
    }).success, false);
  });

  it("validates distinct office/WFH session correction choices and requires a reason", () => {
    assert.equal(attendanceSessionModeCorrectionInputSchema.safeParse({
      requestedMode: "WFH",
      reason: "I selected the wrong IN punch.",
    }).success, true);
    assert.equal(attendanceSessionModeCorrectionInputSchema.safeParse({
      requestedMode: "OFFICE",
      reason: "  ",
    }).success, false);
  });
});

describe("employee correction attendance selection", () => {
  it("lists only persisted daily records scoped to the authenticated employee and active supervisor", async () => {
    let query: unknown;
    const expected = [{
      id: "daily-1",
      date: originalDaily.date,
      firstIn: originalDaily.firstIn,
      lastOut: originalDaily.lastOut,
      status: originalDaily.status,
    }];
    const database: NonNullable<Parameters<typeof listOwnDailyAttendanceForCorrection>[1]> = {
      attendanceDaily: {
        findMany: async (args) => {
          query = args.where;
          return expected;
        },
      },
    };

    const records = await listOwnDailyAttendanceForCorrection(employeeActor, database);
    assert.deepEqual(records, expected);
    assert.deepEqual(query, {
      employee: {
        userId: employeeActor.id,
        supervisor: { user: { role: "SUPERVISOR", isActive: true } },
      },
    });
  });

  it("lists only the authenticated employee's correction history with review details", async () => {
    const stub = createDatabase();
    await employeeCorrection(stub);
    const history = await listOwnAttendanceCorrectionHistory(employeeActor, stub.database);

    assert.equal(history.length, 1);
    assert.equal(history[0]?.id, "correction-1");
    assert.equal(history[0]?.dailyAttendance?.date.toISOString(), originalDaily.date.toISOString());
    assert.equal(history[0]?.status, AttendanceCorrectionStatus.PENDING);
    assert.equal(history[0]?.reason, "Forgot to punch out");
    assert.deepEqual(history[0]?.requestedValues, { lastOut: "2026-10-05T12:00:00.000Z" });
    assert.deepEqual(stub.historyQueries, [{ employeeId: employeeActor.id }]);
  });

  it("rejects users without the employee correction permission before querying", async () => {
    let queried = false;
    const writeDatabase = {
      $transaction: async () => {
        queried = true;
        throw new Error("Unexpected transaction for an unauthorized requester.");
      },
    } as never;
    const database: NonNullable<Parameters<typeof listOwnDailyAttendanceForCorrection>[1]> = {
      attendanceDaily: {
        findMany: async () => {
          queried = true;
          return [];
        },
      },
    };

    await assert.rejects(
      listOwnDailyAttendanceForCorrection({ id: "manager-user", role: Role.DEPARTMENT_MANAGER }, database),
      DailyAttendanceCorrectionAccessError,
    );
    await assert.rejects(
      listOwnDailyAttendanceForCorrection({ id: "admin-user", role: Role.ADMIN }, database),
      DailyAttendanceCorrectionAccessError,
    );
    await assert.rejects(
      submitDailyAttendanceCorrection(adminActor, "daily-1", {
        requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
        reason: "Correct missed punch",
      }, writeDatabase),
      DailyAttendanceCorrectionAccessError,
    );
    await assert.rejects(
      submitAttendanceDateCorrection(adminActor, {
        attendanceDate: "2026-10-05",
        requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
        requestedMode: "OFFICE",
        reason: "Correct missed punch",
      }, writeDatabase),
      DailyAttendanceCorrectionAccessError,
    );
    await assert.rejects(
      submitAttendanceSessionModeCorrection(adminActor, "session-1", {
        requestedMode: "WFH",
        reason: "Correct session mode",
      }, writeDatabase),
      DailyAttendanceCorrectionAccessError,
    );
    assert.equal(queried, false);
  });
});

it("rejects employee corrections when the target does not belong to the requester", async () => {
  const otherEmployee = {
    ...originalDaily,
    employeeId: "employee-2",
    employee: {
      ...originalDaily.employee,
      id: "employee-2",
      userId: "other-supervisor",
    },
  };
  const stub = createDatabase({ daily: otherEmployee });
  await assert.rejects(
    submitDailyAttendanceCorrection(employeeActor, "daily-1", {
      requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
      reason: "Forgot to punch out",
    }, stub.database),
    DailyAttendanceCorrectionAccessError,
  );
  assert.equal(stub.requests.length, 0);
});

it("fails closed when an employee has no assigned active Supervisor", async () => {
  const unassignedDaily = {
    ...originalDaily,
    employee: { ...originalDaily.employee, supervisor: null },
  };
  const stub = createDatabase({ daily: unassignedDaily });
  await assert.rejects(
    submitDailyAttendanceCorrection(employeeActor, "daily-1", {
      requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
      reason: "Forgot to punch out",
    }, stub.database),
    DailyAttendanceCorrectionReviewerNotFoundError,
  );
  assert.equal(stub.requests.length, 0);
});

describe("pending daily attendance correction requests", () => {
  it("allows an authorized Employee to submit their own correction", async () => {
    const stub = createDatabase();
    const requestedValues = { lastOut: "2026-10-05T12:00:00.000Z" };
    const request = await submitDailyAttendanceCorrection(employeeActor, "daily-1", {
      requestedValues,
      reason: "Forgot to punch out",
    }, stub.database);

    assert.equal(request.status, AttendanceCorrectionStatus.PENDING);
    assert.equal(request.currentApprovalStage, AttendanceCorrectionApprovalStage.SUPERVISOR);
    assert.equal(request.dailyAttendanceId, "daily-1");
    assert.equal(request.requesterId, "user-1");
    assert.equal(request.employeeId, "user-1");
    assert.deepEqual(request.originalValues, {
      employeeId: "employee-1",
      date: "2026-10-05T00:00:00.000Z",
      shiftId: "shift-1",
      firstIn: "2026-10-05T03:00:00.000Z",
      lastOut: null,
      workingHours: null,
      lateMinutes: 0,
      earlyMinutes: null,
      status: "MISSING_PUNCH",
      overtimeHours: null,
    });
    assert.deepEqual(request.requestedValues, requestedValues);
    assert.equal(stub.audits.length, 1);
    assert.deepEqual(stub.audits[0], {
      employeeId: "user-1",
      actorId: "user-1",
      correctionRequestId: request.id,
      actionType: "ATTENDANCE_CORRECTION_REQUESTED",
      previousValues: request.originalValues,
      newValues: requestedValues,
      reason: "Forgot to punch out",
    });
  });

  it("allows an authorized Supervisor to submit while preserving requester and subject attribution", async () => {
    const subjectDaily = {
      ...originalDaily,
      employeeId: "employee-2",
      employee: { ...originalDaily.employee, id: "employee-2", userId: "subject-user" },
    };
    const stub = createDatabase({ daily: subjectDaily });
    const request = await submitDailyAttendanceCorrection(supervisorActor, "daily-1", {
      requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
      reason: "Forgot to punch out",
    }, stub.database);

    assert.equal(request.requesterId, supervisorActor.id);
    assert.equal(request.currentApprovalStage, AttendanceCorrectionApprovalStage.HR);
    assert.equal(request.employeeId, "subject-user");
    assert.notEqual(request.employeeId, supervisorActor.id);
    assert.equal(request.dailyAttendanceId, "daily-1");
    assert.equal(stub.audits[0]?.actorId, supervisorActor.id);
    assert.equal(stub.audits[0]?.employeeId, "subject-user");
    assert.equal(stub.audits[0]?.correctionRequestId, request.id);
    assert.deepEqual(request.originalValues, {
      employeeId: "employee-2",
      date: "2026-10-05T00:00:00.000Z",
      shiftId: "shift-1",
      firstIn: "2026-10-05T03:00:00.000Z",
      lastOut: null,
      workingHours: null,
      lateMinutes: 0,
      earlyMinutes: null,
      status: "MISSING_PUNCH",
      overtimeHours: null,
    });
  });

  it("does not modify the daily result or raw attendance evidence", async () => {
    const stub = createDatabase();
    await submitDailyAttendanceCorrection(employeeActor, "daily-1", {
      requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
      reason: "Forgot to punch out",
    }, stub.database);

    assert.deepEqual(stub.daily, stub.dailyBefore);
    assert.deepEqual(stub.rawMutations, []);
  });

  it("rejects missing daily attendance and missing requester", async () => {
    const missingDaily = createDatabase({ daily: null });
    await assert.rejects(
      submitDailyAttendanceCorrection(employeeActor, "missing", {
        requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
        reason: "Forgot to punch out",
      }, missingDaily.database),
      DailyAttendanceCorrectionTargetNotFoundError,
    );

    const missingRequester = createDatabase({ requesterExists: false });
    await assert.rejects(
      submitDailyAttendanceCorrection(employeeActor, "daily-1", {
        requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
        reason: "Forgot to punch out",
      }, missingRequester.database),
      DailyAttendanceCorrectionRequesterNotFoundError,
    );
    assert.equal(missingRequester.requests.length, 0);
  });

  it("rejects requesters without the correction submission permission", async () => {
    const stub = createDatabase();
    await assert.rejects(
      submitDailyAttendanceCorrection({ id: "manager-user", role: Role.DEPARTMENT_MANAGER }, "daily-1", {
        requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
        reason: "Correction",
      }, stub.database),
      DailyAttendanceCorrectionAccessError,
    );
    assert.equal(stub.requests.length, 0);
  });

  it("rejects a target Employee without a linked User instead of attributing the request to its requester", async () => {
    const noLinkedUser = createDatabase({
      daily: { ...originalDaily, employee: { ...originalDaily.employee, id: "employee-2", userId: null } },
    });
    await assert.rejects(
      submitDailyAttendanceCorrection(supervisorActor, "daily-1", {
        requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
        reason: "Correction",
      }, noLinkedUser.database),
      DailyAttendanceCorrectionSubjectUserNotFoundError,
    );
    assert.equal(noLinkedUser.requests.length, 0);
  });

  it("rejects a second pending request for the same daily record", async () => {
    const stub = createDatabase();
    await employeeCorrection(stub);
    await assert.rejects(
      submitDailyAttendanceCorrection(employeeActor, "daily-1", {
        requestedValues: { lastOut: "2026-10-05T12:01:00.000Z" },
        reason: "Second request",
      }, stub.database),
      DailyAttendanceCorrectionPendingRequestExistsError,
    );
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0]?.status, AttendanceCorrectionStatus.PENDING);
  });
});

describe("attendance session work-mode correction requests", () => {
  it("lists only the employee's own sessions for correction", async () => {
    const stub = createDatabase();
    const sessions = await listOwnAttendanceSessionsForCorrection(employeeActor, stub.database);

    assert.deepEqual(sessions, [{
      id: "session-1",
      mode: "OFFICE",
      startAt: new Date("2026-10-05T03:00:00.000Z"),
      endAt: null,
    }]);
  });

  for (const [currentMode, requestedMode] of [["OFFICE", "WFH"], ["WFH", "OFFICE"]] as const) {
    it(`allows a reviewed ${currentMode} to ${requestedMode} correction without changing session or raw evidence while pending`, async () => {
      const stub = createDatabase({
        session: {
          id: "session-1",
          mode: currentMode,
          startAt: new Date("2026-10-05T03:00:00.000Z"),
          endAt: null,
          employeeId: "user-1",
        },
      });
      const rawBefore = structuredClone(stub.rawPunches);
      const request = await submitAttendanceSessionModeCorrection(employeeActor, "session-1", {
        requestedMode,
        reason: "I selected the wrong IN punch.",
      }, stub.database);

      assert.equal(request.sessionId, "session-1");
      assert.equal(request.originalMode, currentMode);
      assert.equal(request.requestedMode, requestedMode);
      assert.equal(request.status, AttendanceCorrectionStatus.PENDING);
      assert.equal(stub.session?.mode, currentMode);
      assert.equal(stub.audits[0]?.sessionId, "session-1");
      assert.deepEqual(stub.rawPunches, rawBefore);
      assert.deepEqual(stub.rawMutations, []);
    });
  }

  it("rejects another employee's session and does not create a request or audit", async () => {
    const stub = createDatabase({
      session: {
        id: "other-session",
        mode: "WFH",
        startAt: new Date("2026-10-05T03:00:00.000Z"),
        endAt: null,
        employeeId: "other-supervisor",
      },
    });
    await assert.rejects(
      submitAttendanceSessionModeCorrection(employeeActor, "other-session", {
        requestedMode: "OFFICE",
        reason: "Wrong mode",
      }, stub.database),
      DailyAttendanceCorrectionAccessError,
    );
    assert.equal(stub.requests.length, 0);
    assert.equal(stub.audits.length, 0);
  });

  it("rejects non-employee actors on the server even when their role can review corrections", async () => {
    const stub = createDatabase();
    await assert.rejects(
      submitAttendanceSessionModeCorrection(supervisorActor, "session-1", {
        requestedMode: "WFH",
        reason: "Wrong mode",
      }, stub.database),
      DailyAttendanceCorrectionAccessError,
    );
    assert.equal(stub.requests.length, 0);
  });

  it("rejects a duplicate pending session correction and a no-op mode request", async () => {
    const stub = createDatabase();
    await submitAttendanceSessionModeCorrection(employeeActor, "session-1", {
      requestedMode: "WFH",
      reason: "Wrong mode",
    }, stub.database);

    await assert.rejects(
      submitAttendanceSessionModeCorrection(employeeActor, "session-1", {
        requestedMode: "WFH",
        reason: "Again",
      }, stub.database),
      DailyAttendanceCorrectionPendingRequestExistsError,
    );
    const noOp = createDatabase();
    await assert.rejects(
      submitAttendanceSessionModeCorrection(employeeActor, "session-1", {
        requestedMode: "OFFICE",
        reason: "No-op",
      }, noOp.database),
      /Choose the other work mode/,
    );
    assert.equal(stub.requests.length, 1);
  });

  it("does not change a session when a mode correction is rejected", async () => {
    const stub = createDatabase();
    const request = await submitAttendanceSessionModeCorrection(employeeActor, "session-1", {
      requestedMode: "WFH",
      reason: "Wrong punch type",
    }, stub.database);
    const auditCount = stub.audits.length;
    const rawBefore = structuredClone(stub.rawPunches);

    const result = await decideDailyAttendanceCorrection(supervisorActor, request.id, {
      action: "REJECT",
      reason: "Evidence does not support the change.",
    }, stub.database);

    assert.equal(result.status, AttendanceCorrectionStatus.REJECTED);
    assert.equal(stub.session?.mode, "OFFICE");
    assert.equal(stub.audits.length, auditCount + 1);
    assert.equal(stub.audits.at(-1)?.sessionId, "session-1");
    assert.deepEqual(stub.rawPunches, rawBefore);
    assert.deepEqual(stub.rawMutations, []);
  });

  it("prevents the affected HR Administrator from approving a work-mode correction for their own session", async () => {
    const stub = createDatabase({
      session: {
        id: "hr-session",
        mode: "WFH",
        startAt: new Date("2026-10-05T03:00:00.000Z"),
        endAt: null,
        employeeId: "hr-user",
      },
    });
    stub.requests.push({
      id: "correction-self",
      employeeId: "hr-user",
      requesterId: "hr-user",
      sessionId: "hr-session",
      originalMode: "WFH",
      requestedMode: "OFFICE",
      originalStartAt: stub.session?.startAt,
      originalEndAt: stub.session?.endAt,
      originalValues: { mode: "WFH" },
      requestedValues: { requestedMode: "OFFICE" },
      reason: "Wrong mode",
      status: AttendanceCorrectionStatus.PENDING,
      currentApprovalStage: AttendanceCorrectionApprovalStage.HR,
    });

    const auditsBefore = structuredClone(stub.audits);
    const notificationsBefore = structuredClone(stub.notifications);
    await assert.rejects(
      decideDailyAttendanceCorrection(
        { id: "hr-user", role: Role.HR_ADMINISTRATOR },
        "correction-self",
        { action: "APPROVE" },
        stub.database,
      ),
      DailyAttendanceCorrectionSelfApprovalError,
    );
    assert.equal(stub.session?.mode, "WFH");
    assert.equal(stub.requests[0]?.status, AttendanceCorrectionStatus.PENDING);
    assert.deepEqual(stub.audits, auditsBefore);
    assert.deepEqual(stub.notifications, notificationsBefore);
  });

  it("rejects a supervisor outside the session employee's assignment scope", async () => {
    const stub = createDatabase({ supervisorUserId: "other-supervisor" });
    const request = await submitAttendanceSessionModeCorrection(employeeActor, "session-1", {
      requestedMode: "WFH",
      reason: "Wrong mode",
    }, stub.database);
    await assert.rejects(
      decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, stub.database),
      DailyAttendanceCorrectionReviewerScopeError,
    );
    assert.equal(stub.requests[0]?.status, AttendanceCorrectionStatus.PENDING);
    assert.equal(stub.session?.mode, "OFFICE");
  });

  it("does not approve a stale mode correction after the session changed", async () => {
    const stub = createDatabase();
    const request = await submitAttendanceSessionModeCorrection(employeeActor, "session-1", {
      requestedMode: "WFH",
      reason: "Wrong mode",
    }, stub.database);
    stub.session!.mode = "WFH";
    const auditsBefore = structuredClone(stub.audits);
    const notificationsBefore = structuredClone(stub.notifications);

    await assert.rejects(
      decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, stub.database),
      DailyAttendanceCorrectionConflictError,
    );
    assert.equal(stub.requests[0]?.status, AttendanceCorrectionStatus.PENDING);
    assert.deepEqual(stub.audits, auditsBefore);
    assert.deepEqual(stub.notifications, notificationsBefore);
  });

  it("preserves a later valid OUT punch if an active-session correction is approved afterward", async () => {
    const stub = createDatabase();
    const request = await submitAttendanceSessionModeCorrection(employeeActor, "session-1", {
      requestedMode: "WFH",
      reason: "Wrong IN type",
    }, stub.database);
    const actualOut = new Date("2026-10-05T12:00:00.000Z");
    stub.session!.endAt = actualOut;

    await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, stub.database);
    const finalDecision = await decideDailyAttendanceCorrection(
      { id: "hr-user", role: Role.HR_ADMINISTRATOR },
      request.id,
      { action: "APPROVE" },
      stub.database,
    );

    assert.equal(finalDecision.status, AttendanceCorrectionStatus.APPROVED);
    assert.equal(stub.session?.mode, "WFH");
    assert.equal(stub.session?.endAt?.toISOString(), actualOut.toISOString());
    assert.equal(
      (stub.audits.at(-1)?.newValues as { session: { endAt: string } }).session.endAt,
      actualOut.toISOString(),
    );
  });

  it("changes the session only after supervisor and HR approvals while retaining raw punch evidence", async () => {
    const stub = createDatabase();
    const request = await submitAttendanceSessionModeCorrection(employeeActor, "session-1", {
      requestedMode: "WFH",
      reason: "I accidentally used the office IN punch.",
    }, stub.database);
    const rawBefore = structuredClone(stub.rawPunches);

    const supervisorDecision = await decideDailyAttendanceCorrection(supervisorActor, request.id, {
      action: "APPROVE",
    }, stub.database);
    assert.equal(supervisorDecision.status, AttendanceCorrectionStatus.PENDING);
    assert.equal(stub.session?.mode, "OFFICE");
    assert.equal(stub.requests[0]?.currentApprovalStage, AttendanceCorrectionApprovalStage.HR);

    const hrDecision = await decideDailyAttendanceCorrection(
      { id: "hr-user", role: Role.HR_ADMINISTRATOR },
      request.id,
      { action: "APPROVE" },
      stub.database,
    );
    assert.equal(hrDecision.status, AttendanceCorrectionStatus.APPROVED);
    assert.equal(stub.session?.mode, "WFH");
    assert.deepEqual(stub.rawPunches, rawBefore);
    assert.deepEqual(stub.rawMutations, []);
    assert.deepEqual(stub.audits.at(-1)?.newValues, {
      status: AttendanceCorrectionStatus.APPROVED,
      currentApprovalStage: null,
      actorRole: Role.HR_ADMINISTRATOR,
      session: {
        sessionId: "session-1",
        mode: "WFH",
        startAt: "2026-10-05T03:00:00.000Z",
        endAt: null,
      },
    });

    it("supports final approval from WFH to office with the same two-stage safeguards", async () => {
      const stub = createDatabase({
        session: {
          id: "session-1",
          mode: "WFH",
          startAt: new Date("2026-10-05T03:00:00.000Z"),
          endAt: new Date("2026-10-05T12:00:00.000Z"),
          employeeId: "user-1",
        },
      });
      const request = await submitAttendanceSessionModeCorrection(employeeActor, "session-1", {
        requestedMode: "OFFICE",
        reason: "I used WFH-IN by mistake.",
      }, stub.database);
      await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, stub.database);
      const result = await decideDailyAttendanceCorrection(
        { id: "hr-user", role: Role.HR_ADMINISTRATOR },
        request.id,
        { action: "APPROVE" },
        stub.database,
      );

      assert.equal(result.status, AttendanceCorrectionStatus.APPROVED);
      assert.equal(stub.session?.mode, "OFFICE");
    });
  });
});

async function employeeCorrection(stub: ReturnType<typeof createDatabase>) {
  return submitDailyAttendanceCorrection(employeeActor, "daily-1", {
    requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
    reason: "Forgot to punch out",
  }, stub.database);
}

describe("attendance correction approvals", () => {
  it("prevents an HR Administrator from approving their own attendance correction without changing state", async () => {
    const hrDaily = {
      ...originalDaily,
      employee: { ...originalDaily.employee, userId: "hr-user" },
    };
    const stub = createDatabase({ daily: hrDaily });
    const request = await submitDailyAttendanceCorrection(supervisorActor, "daily-1", {
      requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
      reason: "HR self-correction",
    }, stub.database);
    const auditsBefore = structuredClone(stub.audits);
    const notificationsBefore = structuredClone(stub.notifications);
    const dailyBefore = structuredClone(stub.daily);

    await assert.rejects(
      decideDailyAttendanceCorrection(
        { id: "hr-user", role: Role.HR_ADMINISTRATOR },
        request.id,
        { action: "APPROVE" },
        stub.database,
      ),
      DailyAttendanceCorrectionSelfApprovalError,
    );

    assert.equal(stub.requests[0]?.status, AttendanceCorrectionStatus.PENDING);
    assert.equal(stub.requests[0]?.currentApprovalStage, AttendanceCorrectionApprovalStage.HR);
    assert.deepEqual(stub.daily, dailyBefore);
    assert.deepEqual(stub.audits, auditsBefore);
    assert.deepEqual(stub.notifications, notificationsBefore);
  });

  it("lists supervisor review only for requests assigned to that supervisor", async () => {
    const stub = createDatabase();
    await employeeCorrection(stub);
    const items = await listDailyAttendanceCorrections(supervisorActor, stub.database);
    assert.equal(items.length, 1);
    assert.deepEqual(stub.requests[0]?.currentApprovalStage, AttendanceCorrectionApprovalStage.SUPERVISOR);
    assert.deepEqual(stub.correctionQueries[0], {
      status: AttendanceCorrectionStatus.PENDING,
      currentApprovalStage: {
        in: [AttendanceCorrectionApprovalStage.SUPERVISOR, AttendanceCorrectionApprovalStage.HR],
      },
      OR: [
        { dailyAttendance: { employee: { supervisor: { userId: supervisorActor.id } } } },
        { employee: { employee: { supervisor: { userId: supervisorActor.id } } } },
        {
          session: {
            record: {
              employee: {
                employee: { supervisor: { userId: supervisorActor.id } },
              },
            },
          },
        },
      ],
    });

    const unassigned = createDatabase({ supervisorUserId: "other-supervisor" });
    await employeeCorrection(unassigned);
    await assert.rejects(
      decideDailyAttendanceCorrection(supervisorActor, "correction-1", { action: "APPROVE" }, unassigned.database),
      DailyAttendanceCorrectionReviewerScopeError,
    );
  });

  it("advances an assigned employee correction from Supervisor to HR without applying it", async () => {
    const stub = createDatabase();
    const request = await employeeCorrection(stub);
    const result = await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, stub.database);

    assert.equal(result.status, AttendanceCorrectionStatus.PENDING);
    assert.equal(result.currentApprovalStage, AttendanceCorrectionApprovalStage.HR);
    assert.equal(stub.daily?.lastOut, null);
    assert.equal(stub.audits.at(-1)?.actionType, "ATTENDANCE_CORRECTION_SUPERVISOR_APPROVED");
    assert.equal(stub.audits.at(-1)?.actorId, supervisorActor.id);
    assert.equal(stub.audits.at(-1)?.correctionRequestId, request.id);
    assert.deepEqual(stub.notifications.map(({ userId, type }) => ({ userId, type })), [
      { userId: "supervisor-user", type: "ATTENDANCE_CORRECTION_PENDING" },
      { userId: "hr-user", type: "ATTENDANCE_CORRECTION_PENDING" },
    ]);
  });

  it("does not commit a Supervisor decision if employee assignment changes before the conditional update", async () => {
    const stub = createDatabase({ changeSupervisorBeforeConditionalUpdate: true });
    const request = await employeeCorrection(stub);

    await assert.rejects(
      decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, stub.database),
      DailyAttendanceCorrectionStageError,
    );

    assert.equal(stub.requests[0]?.status, AttendanceCorrectionStatus.PENDING);
    assert.equal(stub.requests[0]?.currentApprovalStage, AttendanceCorrectionApprovalStage.SUPERVISOR);
    assert.equal(stub.audits.length, 1);
    assert.equal(stub.daily?.lastOut, null);
    assert.equal(stub.notifications.length, 1);
  });

  it("allows only one of two concurrent decisions for the same pending stage", async () => {
    const stub = createDatabase();
    const request = await employeeCorrection(stub);
    const outcomes = await Promise.allSettled([
      decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, stub.database),
      decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "REJECT", reason: "Concurrent decision" }, stub.database),
    ]);

    assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
    assert.equal(stub.requests[0]?.currentApprovalStage === AttendanceCorrectionApprovalStage.HR, true);
    assert.equal(stub.audits.length, 2);
  });

  it("allows the assigned Supervisor to reject and records the rejection", async () => {
    const stub = createDatabase();
    const request = await employeeCorrection(stub);
    const result = await decideDailyAttendanceCorrection(
      supervisorActor,
      request.id,
      { action: "REJECT", reason: "Incorrect requested time" },
      stub.database,
    );

    assert.equal(result.status, AttendanceCorrectionStatus.REJECTED);
    assert.equal(result.currentApprovalStage, null);
    assert.equal(stub.daily?.lastOut, null);
    assert.equal(stub.audits.at(-1)?.actionType, "ATTENDANCE_CORRECTION_REJECTED");
    assert.equal(stub.audits.at(-1)?.reason, "Incorrect requested time");
    assert.deepEqual(stub.notifications.at(-1), {
      userId: "user-1",
      title: "Attendance correction rejected",
      message: "Your attendance correction was rejected.",
      type: "ATTENDANCE_CORRECTION_REJECTED",
    });
  });

  it("sends a Supervisor-submitted correction directly to HR review", async () => {
    const subjectDaily = {
      ...originalDaily,
      employeeId: "employee-2",
      employee: { ...originalDaily.employee, id: "employee-2", userId: "subject-user" },
    };
    const stub = createDatabase({ daily: subjectDaily });
    const request = await submitDailyAttendanceCorrection(supervisorActor, "daily-1", {
      requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
      reason: "Forgot to punch out",
    }, stub.database);
    assert.equal(request.currentApprovalStage, AttendanceCorrectionApprovalStage.HR);
    const items = await listDailyAttendanceCorrections({ id: "hr-user", role: Role.HR_ADMINISTRATOR }, stub.database);
    assert.equal(items.length, 1);
    assert.deepEqual(stub.notifications, [{
      userId: "hr-user",
      title: "Attendance correction pending",
      message: "An attendance correction for 2026-10-05 is awaiting your review.",
      type: "ATTENDANCE_CORRECTION_PENDING",
    }]);
    const result = await decideDailyAttendanceCorrection(
      { id: "hr-user", role: Role.HR_ADMINISTRATOR },
      request.id,
      { action: "APPROVE" },
      stub.database,
    );
    assert.equal(result.status, AttendanceCorrectionStatus.APPROVED);
    assert.deepEqual(stub.notifications.slice(1), [{
      userId: "subject-user",
      title: "Attendance correction approved",
      message: "Your attendance correction was approved.",
      type: "ATTENDANCE_CORRECTION_APPROVED",
    }]);
  });

  it("allows the Super Administrator to list the organization-wide correction review queue", async () => {
    const stub = createDatabase();
    await employeeCorrection(stub);

    const items = await listDailyAttendanceCorrections(adminActor, stub.database);

    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, "correction-1");
    assert.deepEqual(stub.correctionQueries[0], {
      status: AttendanceCorrectionStatus.PENDING,
      currentApprovalStage: {
        in: [AttendanceCorrectionApprovalStage.SUPERVISOR, AttendanceCorrectionApprovalStage.HR],
      },
    });
  });

  it("lets HR approve the final correction and applies only requested daily values", async () => {
    const stub = createDatabase();
    const request = await employeeCorrection(stub);
    await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, stub.database);
    const snapshot = structuredClone(stub.requests[0]?.originalValues);
    const result = await decideDailyAttendanceCorrection(
      { id: "hr-user", role: Role.HR_ADMINISTRATOR },
      request.id,
      { action: "APPROVE" },
      stub.database,
    );

    assert.equal(result.status, AttendanceCorrectionStatus.APPROVED);
    assert.equal(result.currentApprovalStage, null);
    assert.equal(stub.daily?.lastOut?.toISOString(), "2026-10-05T12:00:00.000Z");
    assert.equal(stub.daily?.workingHours, 9);
    assert.equal(stub.daily?.lateMinutes, 0);
    assert.equal(stub.daily?.earlyMinutes, 0);
    assert.equal(stub.daily?.status, "PRESENT");
    assert.deepEqual(stub.requests[0]?.originalValues, snapshot);
    assert.deepEqual(stub.rawMutations, []);
    assert.deepEqual(stub.rawPunches, stub.rawBefore);
    assert.equal(stub.audits.at(-1)?.actorId, "hr-user");
    assert.equal(stub.audits.at(-1)?.employeeId, "user-1");
    assert.equal(stub.audits.at(-1)?.correctionRequestId, request.id);
    assert.equal(stub.audits.at(-1)?.actionType, "ATTENDANCE_CORRECTION_HR_APPROVED");
    assert.equal(stub.audits.at(-1)?.reason, "Forgot to punch out");
    assert.equal(stub.notifications.length, 3);
    assert.deepEqual(stub.notifications.at(-1), {
      userId: "user-1",
      title: "Attendance correction approved",
      message: "Your attendance correction was approved.",
      type: "ATTENDANCE_CORRECTION_APPROVED",
    });
    await assert.rejects(
      decideDailyAttendanceCorrection(
        { id: "hr-user", role: Role.HR_ADMINISTRATOR },
        request.id,
        { action: "APPROVE" },
        stub.database,
      ),
      DailyAttendanceCorrectionStageError,
    );
    assert.equal(stub.notifications.length, 3);
  });

  it("notifies the next reviewer and does not notify the employee after a failed finalization", async () => {
    const stub = createDatabase({ failDailyUpdate: true });
    const request = await employeeCorrection(stub);
    await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, stub.database);
    assert.equal(stub.notifications.length, 2);
    assert.equal(stub.notifications.at(-1)?.userId, "hr-user");

    await assert.rejects(
      decideDailyAttendanceCorrection(
        { id: "hr-user", role: Role.HR_ADMINISTRATOR },
        request.id,
        { action: "APPROVE" },
        stub.database,
      ),
      DailyAttendanceCorrectionConflictError,
    );
    assert.equal(stub.notifications.length, 2);
  });

  it("recalculates late and early metrics from corrected punches using the attendance engine", async () => {
    const lateStub = createDatabase();
    const lateRequest = await submitDailyAttendanceCorrection(employeeActor, "daily-1", {
      requestedValues: {
        firstIn: "2026-10-05T03:18:00.000Z",
        lastOut: "2026-10-05T12:00:00.000Z",
      },
      reason: "Corrected attendance times",
    }, lateStub.database);
    await decideDailyAttendanceCorrection(supervisorActor, lateRequest.id, { action: "APPROVE" }, lateStub.database);
    await decideDailyAttendanceCorrection(
      { id: "hr-user", role: Role.HR_ADMINISTRATOR },
      lateRequest.id,
      { action: "APPROVE" },
      lateStub.database,
    );

    assert.equal(lateStub.daily?.firstIn?.toISOString(), "2026-10-05T03:18:00.000Z");
    assert.equal(lateStub.daily?.lastOut?.toISOString(), "2026-10-05T12:00:00.000Z");
    assert.equal(lateStub.daily?.workingHours, 8.7);
    assert.equal(lateStub.daily?.lateMinutes, 8);
    assert.equal(lateStub.daily?.earlyMinutes, 0);
    assert.equal(lateStub.daily?.status, "LATE");
    assert.deepEqual(lateStub.rawPunches, lateStub.rawBefore);

    const earlyStub = createDatabase();
    const earlyRequest = await submitDailyAttendanceCorrection(employeeActor, "daily-1", {
      requestedValues: {
        firstIn: "2026-10-05T03:00:00.000Z",
        lastOut: "2026-10-05T11:30:00.000Z",
      },
      reason: "Corrected departure time",
    }, earlyStub.database);
    await decideDailyAttendanceCorrection(supervisorActor, earlyRequest.id, { action: "APPROVE" }, earlyStub.database);
    await decideDailyAttendanceCorrection(
      { id: "hr-user", role: Role.HR_ADMINISTRATOR },
      earlyRequest.id,
      { action: "APPROVE" },
      earlyStub.database,
    );

    assert.equal(earlyStub.daily?.firstIn?.toISOString(), "2026-10-05T03:00:00.000Z");
    assert.equal(earlyStub.daily?.lastOut?.toISOString(), "2026-10-05T11:30:00.000Z");
    assert.equal(earlyStub.daily?.workingHours, 8.5);
    assert.equal(earlyStub.daily?.lateMinutes, 0);
    assert.equal(earlyStub.daily?.earlyMinutes, 30);
    assert.equal(earlyStub.daily?.status, "EARLY_OUT");
    assert.deepEqual(earlyStub.rawPunches, earlyStub.rawBefore);
  });

  it("allows HR to reject an HR-stage correction without changing attendance", async () => {
    const subjectDaily = {
      ...originalDaily,
      employeeId: "employee-2",
      employee: { ...originalDaily.employee, id: "employee-2", userId: "subject-user" },
    };
    const stub = createDatabase({ daily: subjectDaily });
    const request = await submitDailyAttendanceCorrection(supervisorActor, "daily-1", {
      requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
      reason: "Forgot to punch out",
    }, stub.database);
    const result = await decideDailyAttendanceCorrection(
      { id: "hr-user", role: Role.HR_ADMINISTRATOR },
      request.id,
      { action: "REJECT" },
      stub.database,
    );
    assert.equal(result.status, AttendanceCorrectionStatus.REJECTED);
    assert.equal(stub.daily?.lastOut, null);
    assert.equal(stub.audits.at(-1)?.actionType, "ATTENDANCE_CORRECTION_REJECTED");
  });

  it("rejects non-reviewer roles and finalized requests", async () => {
    const stub = createDatabase();
    const request = await employeeCorrection(stub);
    await assert.rejects(
      decideDailyAttendanceCorrection(employeeActor, request.id, { action: "APPROVE" }, stub.database),
      DailyAttendanceCorrectionAccessError,
    );
    await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "REJECT" }, stub.database);
    await assert.rejects(
      decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, stub.database),
      DailyAttendanceCorrectionStageError,
    );
    assert.deepEqual(stub.notifications.map(({ userId, type }) => ({ userId, type })), [
      { userId: "supervisor-user", type: "ATTENDANCE_CORRECTION_PENDING" },
      { userId: "user-1", type: "ATTENDANCE_CORRECTION_REJECTED" },
    ]);
  });

  it("allows HR and Supervisors to review either stage while requiring different reviewers", async () => {
    const stub = createDatabase();
    const request = await employeeCorrection(stub);
    await decideDailyAttendanceCorrection(
      { id: "hr-user", role: Role.HR_ADMINISTRATOR },
      request.id,
      { action: "APPROVE" },
      stub.database,
    );
    assert.equal(stub.requests[0]?.currentApprovalStage, AttendanceCorrectionApprovalStage.HR);
    await assert.rejects(
      decideDailyAttendanceCorrection(
        { id: "hr-user", role: Role.HR_ADMINISTRATOR },
        request.id,
        { action: "APPROVE" },
        stub.database,
      ),
      DailyAttendanceCorrectionSelfApprovalError,
    );
    const result = await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, stub.database);
    assert.equal(result.status, AttendanceCorrectionStatus.APPROVED);
    assert.deepEqual(stub.audits.slice(-2).map(({ actorId, actionType }) => ({ actorId, actionType })), [
      { actorId: "hr-user", actionType: "ATTENDANCE_CORRECTION_SUPERVISOR_APPROVED" },
      { actorId: supervisorActor.id, actionType: "ATTENDANCE_CORRECTION_HR_APPROVED" },
    ]);
    assert.equal((stub.audits.at(-2)?.newValues as Record<string, unknown>).actorRole, Role.HR_ADMINISTRATOR);
    assert.equal((stub.audits.at(-1)?.newValues as Record<string, unknown>).actorRole, Role.SUPERVISOR);
  });

  it("allows Super Administrators to review both existing stages but not both decisions", async () => {
    const stub = createDatabase();
    const request = await employeeCorrection(stub);
    const queue = await listDailyAttendanceCorrections(adminActor, stub.database);
    assert.equal(queue.length, 1);

    await decideDailyAttendanceCorrection(adminActor, request.id, { action: "APPROVE" }, stub.database);
    assert.equal(stub.requests[0]?.currentApprovalStage, AttendanceCorrectionApprovalStage.HR);
    await assert.rejects(
      decideDailyAttendanceCorrection(adminActor, request.id, { action: "APPROVE" }, stub.database),
      DailyAttendanceCorrectionSelfApprovalError,
    );
    const result = await decideDailyAttendanceCorrection(
      { id: "hr-user", role: Role.HR_ADMINISTRATOR },
      request.id,
      { action: "APPROVE" },
      stub.database,
    );
    assert.equal(result.status, AttendanceCorrectionStatus.APPROVED);
    assert.equal(stub.audits.at(-2)?.actorId, adminActor.id);
    assert.equal(stub.audits.at(-1)?.actorId, "hr-user");
    assert.equal((stub.audits.at(-2)?.newValues as Record<string, unknown>).actorRole, Role.ADMIN);

    const directToHr = createDatabase({
      daily: {
        ...originalDaily,
        employeeId: "employee-2",
        employee: { ...originalDaily.employee, id: "employee-2", userId: "subject-user" },
      },
    });
    const hrStageRequest = await submitDailyAttendanceCorrection(supervisorActor, "daily-1", {
      requestedValues: { lastOut: "2026-10-05T12:00:00.000Z" },
      reason: "Supervisor submitted correction",
    }, directToHr.database);
    assert.equal(hrStageRequest.currentApprovalStage, AttendanceCorrectionApprovalStage.HR);
    await decideDailyAttendanceCorrection(adminActor, hrStageRequest.id, { action: "REJECT" }, directToHr.database);
    assert.equal(directToHr.requests[0]?.status, AttendanceCorrectionStatus.REJECTED);
  });

  it("allows an Engineering Department Manager to review assigned-department requests only", async () => {
    const inScope = createDatabase({
      managerDepartmentId: "engineering-dept",
      managerDepartmentName: "Engineering",
    });
    const request = await employeeCorrection(inScope);
    const manager = { id: "department-manager", role: Role.DEPARTMENT_MANAGER };
    assert.equal((await listDailyAttendanceCorrections(manager, inScope.database)).length, 1);
    const firstDecision = await decideDailyAttendanceCorrection(manager, request.id, { action: "APPROVE" }, inScope.database);
    assert.equal(firstDecision.currentApprovalStage, AttendanceCorrectionApprovalStage.HR);
    assert.equal(inScope.audits.at(-1)?.actorId, manager.id);
    assert.equal((inScope.audits.at(-1)?.newValues as Record<string, unknown>).actorRole, Role.DEPARTMENT_MANAGER);
    await assert.rejects(
      decideDailyAttendanceCorrection(manager, request.id, { action: "APPROVE" }, inScope.database),
      DailyAttendanceCorrectionSelfApprovalError,
    );
    const finalDecision = await decideDailyAttendanceCorrection(
      { id: "hr-user", role: Role.HR_ADMINISTRATOR },
      request.id,
      { action: "APPROVE" },
      inScope.database,
    );
    assert.equal(finalDecision.status, AttendanceCorrectionStatus.APPROVED);

    const outOfScope = createDatabase({
      managerDepartmentId: "engineering-dept",
      managerDepartmentName: "Engineering",
      employeeDepartmentId: "finance-dept",
    });
    const foreignRequest = await employeeCorrection(outOfScope);
    assert.equal((await listDailyAttendanceCorrections(manager, outOfScope.database)).length, 0);
    await assert.rejects(
      decideDailyAttendanceCorrection(manager, foreignRequest.id, { action: "APPROVE" }, outOfScope.database),
      DailyAttendanceCorrectionReviewerScopeError,
    );
    assert.equal(outOfScope.requests[0]?.status, AttendanceCorrectionStatus.PENDING);
    assert.equal(outOfScope.audits.length, 1);
  });

  it("allows an HR Department Manager to review requests across departments", async () => {
    const stub = createDatabase({
      managerDepartmentId: "hr-dept",
      managerDepartmentName: "Human Resources",
      employeeDepartmentId: "finance-dept",
    });
    const request = await employeeCorrection(stub);
    const manager = { id: "department-manager", role: Role.DEPARTMENT_MANAGER };
    assert.equal((await listDailyAttendanceCorrections(manager, stub.database)).length, 1);
    const result = await decideDailyAttendanceCorrection(manager, request.id, { action: "REJECT", reason: "Reviewed by HR department." }, stub.database);
    assert.equal(result.status, AttendanceCorrectionStatus.REJECTED);
    assert.equal(stub.audits.at(-1)?.actorId, manager.id);
    assert.equal(stub.audits.at(-1)?.reason, "Reviewed by HR department.");
  });

  it("rejects stale correction values rather than overwriting a recalculated daily record", async () => {
    const stub = createDatabase();
    const request = await employeeCorrection(stub);
    if (stub.daily) stub.daily.lastOut = new Date("2026-10-05T11:00:00.000Z");
    await assert.rejects(
      decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, stub.database),
      DailyAttendanceCorrectionConflictError,
    );
    assert.equal(stub.requests[0]?.currentApprovalStage, AttendanceCorrectionApprovalStage.SUPERVISOR);
  });
});
