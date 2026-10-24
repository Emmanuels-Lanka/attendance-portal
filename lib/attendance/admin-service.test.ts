import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role } from "@prisma/client";
import {
  AdminAttendanceAuthorizationError,
  AdminAttendanceCorrectionError,
  AdminAttendanceNotFoundError,
  correctAdminAttendance,
  listAdminAttendance,
} from "./admin-service";
import { classifyWorkSession } from "./schedule";

const testShift = {
  id: "shift-1",
  startTime: new Date("1970-01-01T08:00:00.000Z"),
  endTime: new Date("1970-01-01T17:30:00.000Z"),
  gracePeriodMinutes: 10,
  workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
};

type TestSession = {
  id: string;
  mode: "OFFICE" | "WFH";
  startAt: Date;
  endAt: Date | null;
  record: { employee: {
    id: string;
    name: string;
    employeeCode: string;
    timeZone: string;
    countryCode: string;
    email: string;
    role: Role;
    isActive: boolean;
    employee: { id?: string; departmentId: string; supervisor: { userId: string | null } };
  } };
};

function makeSession(
  id: string,
  mode: "OFFICE" | "WFH" = "OFFICE",
  timeZone = "Asia/Colombo",
  supervisorUserId: string | null = "supervisor-user",
  departmentId = "engineering-dept",
): TestSession {
  return {
    id,
    mode,
    startAt: new Date("2026-06-15T02:30:00.000Z"),
    endAt: null,
    record: {
      employee: {
        id: `employee-${id}`,
        name: `Employee ${id}`,
        employeeCode: `CODE-${id}`,
        timeZone,
        countryCode: timeZone === "Asia/Dhaka" ? "BD" : "LK",
        email: `${id}@example.invalid`,
        role: Role.EMPLOYEE,
        isActive: true,
        employee: { departmentId, supervisor: { userId: supervisorUserId } },
      },
    },
  };
}

function createDatabase(
  sessions = [makeSession("one")],
  linkedUserIds?: string[],
  options: {
    failConditionalUpdate?: boolean;
    managerDepartmentId?: string | null;
    managerDepartmentName?: string;
    hasRawPunchEvidence?: boolean;
  } = {},
) {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const employeeRows = [...new Map(sessions.map((session) => [session.record.employee.id, session.record.employee])).values()];
  const calls: {
    findWhere?: unknown;
    rawWhere?: unknown;
    employeeSelect?: unknown;
    updateData?: Record<string, unknown>;
    auditData?: Record<string, unknown>;
  } = {};
  const workSession = {
    findMany: async (args: { where: unknown; include: unknown }) => {
      calls.findWhere = args.where;
      const where = args.where as {
        mode?: "OFFICE" | "WFH";
        endAt?: null | { not: null };
        record?: { employeeId?: { in?: string[] }; employee?: { employee?: { departmentId?: string } } };
        OR?: Array<{ record: { employeeId: string }; startAt?: { gte?: Date; lt?: Date } }>;
      };
      const employeeIds = where.record?.employeeId?.in;
      const queried = [...sessionById.values()].filter((session) => {
        if (employeeIds && !employeeIds.includes(session.record.employee.id)) return false;
        if (where.mode && session.mode !== where.mode) return false;
        if (where.endAt === null && session.endAt !== null) return false;
        if (where.endAt && session.endAt === null) return false;
        if (where.record?.employee?.employee?.departmentId
          && session.record.employee.employee.departmentId !== where.record.employee.employee.departmentId) return false;
        if (where.OR) {
          return where.OR.some((range) =>
            range.record.employeeId === session.record.employee.id
            && (!range.startAt?.gte || session.startAt >= range.startAt.gte)
            && (!range.startAt?.lt || session.startAt < range.startAt.lt));
        }
        return true;
      });
      return queried.map((session) => ({ ...session }));
    },
    findUnique: async ({ where, select }: { where: { id: string }; select?: unknown }) => {
      const session = sessionById.get(where.id);
      if (session && select) return {
        record: {
          employeeId: session.record.employee.id,
          employee: { employee: { id: session.record.employee.employee.id } },
        },
      };
      return session ? { ...session } : null;
    },
    findFirst: async ({ where }: { where: { id?: { not: string }; record: { employeeId: string }; endAt?: null; startAt?: { gte: Date; lt: Date } } }) => {
      const session = [...sessionById.values()].find((item) =>
        item.id !== where.id?.not && item.record.employee.id === where.record.employeeId &&
        (where.endAt === null ? item.endAt === null : Boolean(where.startAt && item.startAt >= where.startAt.gte && item.startAt < where.startAt.lt)),
      );
      return session ? { id: session.id } : null;
    },
    updateMany: async ({ where, data }: {
      where: {
        id: string;
        mode: "OFFICE" | "WFH";
        startAt: Date;
        endAt: Date | null;
        record?: { employee?: { employee?: { departmentId?: string } } };
      };
      data: Record<string, unknown>;
    }) => {
      calls.updateData = data;
      const session = sessionById.get(where.id);
      if (
        options.failConditionalUpdate
        || !session
        || session.mode !== where.mode
        || session.startAt.getTime() !== where.startAt.getTime()
        || session.endAt?.getTime() !== where.endAt?.getTime()
        || (where.record?.employee?.employee?.departmentId
          && session.record.employee.employee.departmentId !== where.record.employee.employee.departmentId)
      ) return { count: 0 };
      const updated = { ...session, ...data } as TestSession;
      sessionById.set(where.id, updated);
      return { count: 1 };
    },
  };
  const transaction = {
    $queryRaw: async () => [],
    user: {
      findMany: async (args: { select: unknown; where?: { id?: string; employee?: { supervisor?: { userId: string | undefined }; departmentId?: string } } }) => {
        calls.employeeSelect = args.select;
        const rows = args.where?.id ? employeeRows.filter((employee) => employee.id === args.where?.id) : employeeRows;
        if (args.where?.employee?.supervisor) {
          return rows.filter((employee) => employee.employee.supervisor.userId === args.where?.employee?.supervisor?.userId);
        }
        if (args.where?.employee?.departmentId) {
          return rows.filter((employee) => employee.employee.departmentId === args.where?.employee?.departmentId);
        }
        return rows;
      },
    },
    employee: {
      findUnique: async ({ where }: { where: { userId?: string; id?: string } }) => {
        if (where.userId === "department-manager") return {
          id: "manager-employee",
          departmentId: options.managerDepartmentId === undefined ? "engineering-dept" : options.managerDepartmentId,
          department: { name: options.managerDepartmentName ?? "Engineering" },
          user: { role: Role.DEPARTMENT_MANAGER, isActive: true },
        };
        return null;
      },
      findMany: async ({ where }: { where: { userId: { in: string[] } } }) => where.userId.in.flatMap((userId) => {
        if (linkedUserIds && !linkedUserIds.includes(userId)) return [];
        const user = employeeRows.find((row) => row.id === userId);
        return user
          ? [{
              id: `record-${user.id}`,
              name: `HR ${user.name}`,
              employeeId: `HR-${user.employeeCode}`,
              userId,
              shift: null,
              shiftAssignments: [{ effectiveFrom: new Date("0001-01-01T00:00:00.000Z"), effectiveTo: null, shift: testShift }],
            }]
          : [];
      }),
    },
    workSession,
    attendanceRaw: {
      findMany: async ({ where }: { where: unknown }) => {
        calls.rawWhere = where;
        return options.hasRawPunchEvidence ? [{ id: "raw-punch" }] : [];
      },
    },
    attendanceAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => { calls.auditData = data; return data; },
    },
  };
  const database = {
    user: {
      findMany: async (args: { select: unknown; where?: { id?: string; employee?: { supervisor?: { userId: string | undefined }; departmentId?: string } } }) => {
        calls.employeeSelect = args.select;
        const rows = args.where?.id ? employeeRows.filter((employee) => employee.id === args.where?.id) : employeeRows;
        if (args.where?.employee?.supervisor) {
          return rows.filter((employee) => employee.employee.supervisor.userId === args.where?.employee?.supervisor?.userId);
        }
        if (args.where?.employee?.departmentId) {
          return rows.filter((employee) => employee.employee.departmentId === args.where?.employee?.departmentId);
        }
        return rows;
      },
    },
    employee: {
      findUnique: async ({ where }: { where: { userId: string } }) => where.userId === "department-manager" ? ({
        departmentId: options.managerDepartmentId === undefined ? "engineering-dept" : options.managerDepartmentId,
        department: { name: options.managerDepartmentName ?? "Engineering" },
        user: { role: Role.DEPARTMENT_MANAGER, isActive: true },
      }) : null,
      findMany: async ({ where }: { where: { userId: { in: string[] } } }) => where.userId.in.flatMap((userId) => {
        if (linkedUserIds && !linkedUserIds.includes(userId)) return [];
        const user = employeeRows.find((row) => row.id === userId);
        return user
          ? [{
              id: `record-${user.id}`,
              name: `HR ${user.name}`,
              employeeId: `HR-${user.employeeCode}`,
              userId,
              shift: null,
              shiftAssignments: [{ effectiveFrom: new Date("0001-01-01T00:00:00.000Z"), effectiveTo: null, shift: testShift }],
            }]
          : [];
      }),
    },
    workSession,
    $transaction: async (operation: (transaction: never) => Promise<unknown>) => operation(transaction as never),
  } as never;
  return { database, calls, sessionById };
}

const admin = { id: "admin-user", role: Role.ADMIN };

function createCrossDateCorrectionDatabase(input: {
  mode?: "OFFICE" | "WFH";
  startAt: Date;
  endAt: Date | null;
  dailyDates: string[];
  rawPunches?: Array<{ timestamp: Date; punchType: "IN" | "OUT"; workMode: "OFFICE" | "WFH" }>;
}) {
  const userId = "cross-date-user";
  const employeeId = "cross-date-employee";
  const session = {
    id: "cross-date-session",
    recordId: "cross-date-record",
    mode: input.mode ?? "OFFICE" as const,
    startAt: input.startAt,
    endAt: input.endAt,
    record: {
      employeeId: userId,
      employee: {
        id: userId,
        name: "Cross Date Employee",
        email: "cross-date@example.invalid",
        employeeCode: "CROSS-1",
        countryCode: "LK",
        timeZone: "Asia/Colombo",
        role: Role.EMPLOYEE,
        isActive: true,
        employee: {
          id: employeeId,
          departmentId: "engineering-dept",
          supervisor: { userId: "supervisor-user" },
        },
      },
    },
  };
  const rawPunches = input.rawPunches ?? [];
  const rawBefore = structuredClone(rawPunches);
  const dailyRows = input.dailyDates.map((date, index) => ({
    id: `daily-${date}`,
    employeeId,
    date: new Date(`${date}T00:00:00.000Z`),
    mode: "OFFICE" as const,
    firstIn: new Date(`${date}T02:30:00.000Z`),
    lastOut: new Date(`${date}T12:00:00.000Z`),
    status: `UNCHANGED-${index}`,
  }));
  const recalculatedDates: string[] = [];
  const transaction = {
    $queryRaw: async () => [],
    workSession: {
      findUnique: async ({ where, select }: { where: { id: string }; select?: unknown }) => {
        if (where.id !== session.id) return null;
        if (select) return { record: { employeeId: userId } };
        return structuredClone(session);
      },
      updateMany: async ({ where, data }: {
        where: { id: string; mode: "OFFICE" | "WFH"; startAt: Date; endAt: Date | null };
        data: { mode?: "OFFICE" | "WFH"; startAt?: Date; endAt?: Date | null };
      }) => {
        if (
          where.id !== session.id
          || where.mode !== session.mode
          || where.startAt.getTime() !== session.startAt.getTime()
          || where.endAt?.getTime() !== session.endAt?.getTime()
        ) return { count: 0 };
        if (data.mode) session.mode = data.mode;
        if (data.startAt) session.startAt = data.startAt;
        if (data.endAt !== undefined) session.endAt = data.endAt;
        return { count: 1 };
      },
      findMany: async ({ where }: {
        where: {
          record: { employeeId: string };
          OR: Array<{ startAt?: { gte: Date; lt: Date }; endAt?: { gte: Date; lt: Date } }>;
        };
      }) => {
        if (where.record.employeeId !== userId) return [];
        const matches = where.OR.some((condition) =>
          (condition.startAt && session.startAt >= condition.startAt.gte && session.startAt < condition.startAt.lt)
          || (condition.endAt && session.endAt
            && session.endAt >= condition.endAt.gte && session.endAt < condition.endAt.lt));
        return matches
          ? [{ id: session.id, mode: session.mode, startAt: session.startAt, endAt: session.endAt }]
          : [];
      },
    },
    employee: {
      findUnique: async () => ({
        id: employeeId,
        userId,
        user: { timeZone: "Asia/Colombo", countryCode: "LK" },
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
        shiftAssignments: [],
      }),
    },
    attendanceRaw: {
      findMany: async ({ where }: {
        where: { employeeId: string; timestamp: { gte: Date; lt: Date } };
      }) => {
        if (where.employeeId !== employeeId) return [];
        return rawPunches.filter(({ timestamp }) =>
          timestamp >= where.timestamp.gte && timestamp < where.timestamp.lt);
      },
    },
    attendanceDaily: {
      findMany: async ({ where }: { where: { employeeId: string; date: Date } }) => {
        const date = where.date.toISOString().slice(0, 10);
        recalculatedDates.push(date);
        return dailyRows.filter((row) =>
          row.employeeId === where.employeeId && row.date.getTime() === where.date.getTime())
          .map(({ id }) => ({ id }));
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `created-${dailyRows.length}`, ...data } as typeof dailyRows[number];
        dailyRows.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = dailyRows.find(({ id }) => id === where.id);
        if (!row) throw new Error("Expected matching daily fixture.");
        Object.assign(row, data);
        return row;
      },
    },
    attendanceCorrectionRequest: { findMany: async () => [] },
    holiday: { findFirst: async () => null },
    attendanceAuditLog: { create: async () => ({ id: "audit-1" }) },
  };
  const database = {
    $transaction: async <T>(operation: (tx: typeof transaction) => Promise<T>) => operation(transaction),
  } as never;
  return { database, session, rawPunches, rawBefore, dailyRows, recalculatedDates };
}

describe("admin attendance access and corrections", () => {
  it("rejects non-admin and unauthenticated attendance reads", async () => {
    const stub = createDatabase();
    await assert.rejects(listAdminAttendance({ role: Role.EMPLOYEE }, {}, stub.database), AdminAttendanceAuthorizationError);
    await assert.rejects(listAdminAttendance(null, {}, stub.database), AdminAttendanceAuthorizationError);
  });

  it("rejects non-admin and unauthenticated corrections without reading or writing sessions", async () => {
    const stub = createDatabase();
    await assert.rejects(correctAdminAttendance({ role: Role.EMPLOYEE }, "one", { startAt: "2026-06-15T08:00" }, stub.database), AdminAttendanceAuthorizationError);
    await assert.rejects(correctAdminAttendance(null, "one", { startAt: "2026-06-15T08:00" }, stub.database), AdminAttendanceAuthorizationError);
    await assert.rejects(
      correctAdminAttendance({ role: Role.HR_ADMINISTRATOR }, "one", { mode: "WFH", reason: "Missing identity." }, stub.database),
      AdminAttendanceAuthorizationError,
    );
    assert.equal(stub.calls.updateData, undefined);
  });

  it("allows HR direct corrections and records actor, action, reason, and before/after values", async () => {
    const stub = createDatabase([makeSession("hr-direct")]);
    const corrected = await correctAdminAttendance(
      { id: "hr-user", role: Role.HR_ADMINISTRATOR },
      "hr-direct",
      { startAt: "2026-06-15T08:15", reason: "Verified the recorded IN was inaccurate." },
      stub.database,
    );

    assert.equal(corrected.startAt.toISOString(), "2026-06-15T02:45:00.000Z");
    assert.equal(stub.calls.auditData?.actorId, "hr-user");
    assert.equal(stub.calls.auditData?.actionType, "ATTENDANCE_DIRECTLY_CORRECTED");
    assert.equal(stub.calls.auditData?.reason, "Verified the recorded IN was inaccurate.");
    assert.deepEqual(stub.calls.auditData?.previousValues, {
      mode: "OFFICE",
      startAt: "2026-06-15T02:30:00.000Z",
      endAt: null,
    });

    it("recalculates the daily result from an effective direct correction without rewriting raw punches", async () => {
      const session = {
        id: "direct-recalc",
        recordId: "record-1",
        mode: "OFFICE" as const,
        startAt: new Date("2026-06-15T03:00:00.000Z"),
        endAt: new Date("2026-06-15T12:00:00.000Z"),
        record: {
          employeeId: "user-1",
          employee: {
            id: "user-1",
            name: "Alex Employee",
            email: "employee@example.invalid",
            employeeCode: "E-1",
            countryCode: "LK",
            timeZone: "Asia/Colombo",
            role: Role.EMPLOYEE,
            isActive: true,
            employee: {
              id: "employee-record-1",
              departmentId: "engineering-dept",
              supervisor: { userId: "supervisor-user" },
            },
          },
        },
      };
      const rawPunches = [
        { id: "raw-in", timestamp: session.startAt, punchType: "IN" as const, workMode: "OFFICE" as const },
        { id: "raw-out", timestamp: session.endAt, punchType: "OUT" as const, workMode: "OFFICE" as const },
      ];
      const rawBefore = structuredClone(rawPunches);
      const dailyRows: Array<Record<string, unknown> & { id: string }> = [];
      const transaction = {
        $queryRaw: async () => [],
        workSession: {
          findUnique: async () => structuredClone(session),
          updateMany: async ({ data }: { data: Partial<typeof session> }) => {
            Object.assign(session, data);
            return { count: 1 };
          },
          findMany: async () => [{
            id: session.id,
            mode: session.mode,
            startAt: session.startAt,
            endAt: session.endAt,
          }],
        },
        employee: {
          findUnique: async () => ({
            id: "employee-record-1",
            userId: "user-1",
            user: { timeZone: "Asia/Colombo", countryCode: "LK" },
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
            },
            shiftAssignments: [],
          }),
        },
        attendanceRaw: { findMany: async () => rawPunches },
        attendanceDaily: {
          findMany: async () => dailyRows.map(({ id }) => ({ id })),
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const row = { id: "daily-1", ...data };
            dailyRows.push(row);
            return row;
          },
          update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            Object.assign(dailyRows.find(({ id }) => id === where.id)!, data);
            return dailyRows.find(({ id }) => id === where.id);
          },
        },
        attendanceCorrectionRequest: { findMany: async () => [] },
        holiday: { findFirst: async () => null },
        attendanceAuditLog: { create: async () => ({ id: "audit-1" }) },
      };
      const database = {
        $transaction: async <T>(operation: (tx: typeof transaction) => Promise<T>) => operation(transaction),
      } as never;

      await correctAdminAttendance(admin, session.id, {
        startAt: "2026-06-15T08:45",
        endAt: "2026-06-15T17:15",
        mode: "WFH",
        reason: "Verified corrected session values.",
      }, database);

      assert.equal(dailyRows[0]?.mode, "WFH");
      assert.equal((dailyRows[0]?.firstIn as Date).toISOString(), "2026-06-15T03:15:00.000Z");
      assert.equal((dailyRows[0]?.lastOut as Date).toISOString(), "2026-06-15T11:45:00.000Z");
      assert.deepEqual(rawPunches, rawBefore);
    });
    assert.deepEqual(stub.calls.auditData?.newValues, {
      mode: "OFFICE",
      startAt: "2026-06-15T02:45:00.000Z",
      endAt: null,
      actorRole: Role.HR_ADMINISTRATOR,
    });
  });

  it("allows Supervisors to directly correct only assigned employees", async () => {
    const stub = createDatabase([makeSession("supervisor-direct", "OFFICE", "Asia/Colombo", "supervisor-user")]);
    const corrected = await correctAdminAttendance(
      { id: "supervisor-user", role: Role.SUPERVISOR },
      "supervisor-direct",
      { mode: "WFH", reason: "Employee confirmed the correct work mode." },
      stub.database,
    );
    assert.equal(corrected.mode, "WFH");
    assert.equal(stub.calls.auditData?.actorId, "supervisor-user");
    assert.equal(stub.calls.auditData?.actionType, "ATTENDANCE_DIRECTLY_CORRECTED");
    assert.equal(stub.calls.auditData?.reason, "Employee confirmed the correct work mode.");
    assert.equal((stub.calls.auditData?.newValues as Record<string, unknown>).actorRole, Role.SUPERVISOR);

    const outsideScope = createDatabase([makeSession("not-assigned", "OFFICE", "Asia/Colombo", "other-supervisor")]);
    await assert.rejects(
      correctAdminAttendance(
        { id: "supervisor-user", role: Role.SUPERVISOR },
        "not-assigned",
        { mode: "WFH", reason: "Should be denied." },
        outsideScope.database,
      ),
      AdminAttendanceAuthorizationError,
    );
    assert.equal(outsideScope.calls.updateData, undefined);
  });

  it("limits a non-HR Department Manager to direct corrections and reads within the assigned department", async () => {
    const departmentSessions = [
      makeSession("engineering-session", "OFFICE", "Asia/Colombo", "supervisor-user", "engineering-dept"),
      makeSession("finance-session", "OFFICE", "Asia/Colombo", "supervisor-user", "finance-dept"),
    ];
    const stub = createDatabase(departmentSessions, undefined, {
      managerDepartmentId: "engineering-dept",
      managerDepartmentName: "Engineering",
    });
    const manager = { id: "department-manager", role: Role.DEPARTMENT_MANAGER };
    const listed = await listAdminAttendance(manager, {}, stub.database);
    assert.deepEqual(listed.sessions.map(({ id }) => id), ["engineering-session"]);
    const corrected = await correctAdminAttendance(
      manager,
      "engineering-session",
      { mode: "WFH", reason: "Corrected by the assigned department manager." },
      stub.database,
    );
    assert.equal(corrected.mode, "WFH");
    await assert.rejects(
      correctAdminAttendance(
        manager,
        "finance-session",
        { mode: "WFH", reason: "Attempt to access another department." },
        stub.database,
      ),
      AdminAttendanceAuthorizationError,
    );
    assert.equal(stub.sessionById.get("finance-session")?.mode, "OFFICE");
  });

  it("allows an HR Department Manager cross-department attendance reads and direct corrections", async () => {
    const stub = createDatabase([
      makeSession("engineering-session", "OFFICE", "Asia/Colombo", "supervisor-user", "engineering-dept"),
      makeSession("finance-session", "OFFICE", "Asia/Dhaka", "supervisor-user", "finance-dept"),
    ], undefined, { managerDepartmentId: "hr-dept", managerDepartmentName: "Human Resources" });
    const manager = { id: "department-manager", role: Role.DEPARTMENT_MANAGER };
    const listed = await listAdminAttendance(manager, {}, stub.database);
    assert.deepEqual(listed.sessions.map(({ id }) => id), ["engineering-session", "finance-session"]);
    const corrected = await correctAdminAttendance(
      manager,
      "finance-session",
      { mode: "WFH", reason: "HR verified a cross-department correction." },
      stub.database,
    );
    assert.equal(corrected.mode, "WFH");
    assert.equal(stub.calls.auditData?.actorId, manager.id);
    assert.equal(stub.calls.auditData?.reason, "HR verified a cross-department correction.");
  });

  it("routes HR and Supervisor self-corrections through the independent request workflow", async () => {
    const hrOwnSession = createDatabase([makeSession("hr-self")]);
    await assert.rejects(
      correctAdminAttendance(
        { id: "employee-hr-self", role: Role.HR_ADMINISTRATOR },
        "hr-self",
        { mode: "WFH", reason: "Self correction attempt." },
        hrOwnSession.database,
      ),
      /Submit a correction request/,
    );
    assert.equal(hrOwnSession.calls.updateData, undefined);

    const supervisorOwnSession = createDatabase([makeSession("supervisor-self", "OFFICE", "Asia/Colombo", "employee-supervisor-self")]);
    await assert.rejects(
      correctAdminAttendance(
        { id: "employee-supervisor-self", role: Role.SUPERVISOR },
        "supervisor-self",
        { mode: "WFH", reason: "Self correction attempt." },
        supervisorOwnSession.database,
      ),
      /Submit a correction request/,
    );
    assert.equal(supervisorOwnSession.calls.updateData, undefined);
  });

  it("prevents the Super Administrator from directly correcting their own attendance", async () => {
    const ownSession = makeSession("admin-self");
    ownSession.record.employee.id = admin.id;
    const stub = createDatabase([ownSession]);

    await assert.rejects(
      correctAdminAttendance(
        admin,
        "admin-self",
        { mode: "WFH", reason: "Self correction attempt." },
        stub.database,
      ),
      /Submit a correction request/,
    );
    assert.equal(stub.calls.updateData, undefined);
    assert.equal(stub.calls.auditData, undefined);
  });

  it("requires a reason for direct administrative attendance corrections", async () => {
    const stub = createDatabase();

    await assert.rejects(
      correctAdminAttendance(admin, "one", { mode: "WFH" }, stub.database),
    );
    assert.equal(stub.calls.updateData, undefined);
    assert.equal(stub.calls.auditData, undefined);
  });

  it("lists Supervisors only attendance sessions belonging to assigned employees", async () => {
    const stub = createDatabase([
      makeSession("assigned", "OFFICE", "Asia/Colombo", "supervisor-user"),
      makeSession("unassigned", "WFH", "Asia/Colombo", "other-supervisor"),
    ]);
    const result = await listAdminAttendance({ id: "supervisor-user", role: Role.SUPERVISOR }, {}, stub.database);

    assert.deepEqual(result.employees.map(({ id }) => id), ["employee-assigned"]);
    assert.deepEqual(result.sessions.map(({ id }) => id), ["assigned"]);
  });

  it("does not write audit data when a concurrent session update invalidates the conditional correction", async () => {
    const stub = createDatabase([makeSession("concurrent")], undefined, { failConditionalUpdate: true });
    await assert.rejects(
      correctAdminAttendance(
        { id: "hr-user", role: Role.HR_ADMINISTRATOR },
        "concurrent",
        { mode: "WFH", reason: "Correct work mode." },
        stub.database,
      ),
      /changed while the correction was being saved/,
    );
    assert.equal(stub.calls.auditData, undefined);
  });

  it("allows an admin to view multiple Office/WFH sessions without exposing password hashes", async () => {
    const stub = createDatabase([makeSession("office", "OFFICE"), makeSession("wfh", "WFH", "Asia/Dhaka")]);
    const result = await listAdminAttendance(admin, {}, stub.database);
    assert.equal(result.sessions.length, 2);
    assert.deepEqual(result.sessions.map((session) => session.mode), ["OFFICE", "WFH"]);
    assert.deepEqual(result.sessions[0].record.employee.employeeRecord, {
      id: "record-employee-office",
      name: "HR Employee office",
      employeeId: "HR-CODE-office",
      shiftAssignments: [{
        effectiveFrom: new Date("0001-01-01T00:00:00.000Z"),
        effectiveTo: null,
        shift: testShift,
      }],
    });
    assert.equal(result.sessions[0].record.employee.id, "employee-office");
    assert.equal(result.employees[0].id, "employee-office");
    assert.equal("passwordHash" in (stub.calls.employeeSelect as object), false);
    assert.equal("passwordHash" in result.sessions[0].record.employee, false);
  });

  it("returns an empty daily summary when the selected employee does not exist", async () => {
    const stub = createDatabase([]);
    const result = await listAdminAttendance(admin, { employeeId: "missing-employee" }, stub.database);
    assert.deepEqual(result.sessions, []);
    assert.deepEqual(result.dailySummaries, []);
  });

  it("returns only the selected employee's sessions and labels for a specific selection", async () => {
    const stub = createDatabase([makeSession("selected"), makeSession("other", "WFH")]);

    const result = await listAdminAttendance(admin, { employeeId: "employee-selected" }, stub.database);

    assert.deepEqual(result.sessions.map(({ id }) => id), ["selected"]);
    assert.deepEqual(result.employees.map(({ id, name }) => ({ id, name })), [{
      id: "employee-selected",
      name: "Employee selected",
    }]);
    assert.deepEqual(result.dailySummaries.map(({ employee }) => employee.id), ["employee-selected"]);
    assert.deepEqual(stub.calls.findWhere, {
      record: { employeeId: { in: ["employee-selected"] } },
    });
  });

  it("uses the all-employees sentinel to remove only the employee restriction", async () => {
    const stub = createDatabase([makeSession("selected"), makeSession("other", "WFH")]);

    const result = await listAdminAttendance(admin, { employeeId: "", mode: "WFH", status: "ACTIVE" }, stub.database);

    assert.deepEqual(result.sessions.map(({ id }) => id), ["other"]);
    assert.deepEqual(result.employees.map(({ id }) => id).sort(), ["employee-other", "employee-selected"]);
    assert.deepEqual(stub.calls.findWhere, {
      mode: "WFH",
      endAt: null,
      record: { employeeId: { in: ["employee-selected", "employee-other"] } },
    });
  });

  it("keeps User-owned attendance readable when no linked Employee exists", async () => {
    const stub = createDatabase([makeSession("legacy-user")], []);

    const result = await listAdminAttendance(admin, {}, stub.database);

    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].record.employee.id, "employee-legacy-user");
    assert.equal(result.sessions[0].record.employee.employeeRecord, null);
    assert.equal(result.employees[0].id, "employee-legacy-user");
    assert.equal(result.employees[0].employeeRecord, null);
  });

  it("filters date ranges with each employee's own timezone", async () => {
    const stub = createDatabase([makeSession("sri-lanka", "OFFICE", "Asia/Colombo"), makeSession("bangladesh", "WFH", "Asia/Dhaka")]);
    await listAdminAttendance(admin, { from: "2026-06-15", to: "2026-06-15" }, stub.database);
    const where = stub.calls.findWhere as { OR: Array<{ record: { employeeId: string }; startAt: { gte: Date; lt: Date } }> };
    assert.equal(where.OR.length, 2);
    const colomboRange = where.OR.find((item) => item.record.employeeId === "employee-sri-lanka")?.startAt;
    const dhakaRange = where.OR.find((item) => item.record.employeeId === "employee-bangladesh")?.startAt;
    assert.equal(colomboRange?.gte.toISOString(), "2026-06-14T18:30:00.000Z");
    assert.equal(dhakaRange?.gte.toISOString(), "2026-06-14T18:00:00.000Z");
  });

  it("applies supported Office/WFH mode and active/completed status filters", async () => {
    const stub = createDatabase([makeSession("filter", "WFH")]);
    await listAdminAttendance(admin, { employeeId: "employee-filter", mode: "WFH", status: "ACTIVE" }, stub.database);
    assert.deepEqual(stub.calls.findWhere, {
      mode: "WFH",
      endAt: null,
      record: { employeeId: { in: ["employee-filter"] } },
    });
    await listAdminAttendance(admin, { employeeId: "employee-filter", mode: "OFFICE", status: "COMPLETED" }, stub.database);
    assert.deepEqual(stub.calls.findWhere, {
      mode: "OFFICE",
      endAt: { not: null },
      record: { employeeId: { in: ["employee-filter"] } },
    });
  });

  it("uses employee-local DST day boundaries for date-range filters", async () => {
    const stub = createDatabase([makeSession("new-york", "OFFICE", "America/New_York")]);
    await listAdminAttendance(admin, { from: "2026-03-08", to: "2026-03-08" }, stub.database);
    const where = stub.calls.findWhere as { OR: Array<{ startAt: { gte: Date; lt: Date } }> };
    assert.equal(where.OR[0].startAt.gte.toISOString(), "2026-03-08T05:00:00.000Z");
    assert.equal(where.OR[0].startAt.lt.toISOString(), "2026-03-09T04:00:00.000Z");
  });

  it("corrects IN in the employee timezone and reuses schedule classification", async () => {
    const stub = createDatabase([makeSession("colombo", "OFFICE", "Asia/Colombo")]);
    const corrected = await correctAdminAttendance(admin, "colombo", { startAt: "2026-06-15T08:15", reason: "Incorrect arrival time" }, stub.database);
    assert.equal(corrected.startAt.toISOString(), "2026-06-15T02:45:00.000Z");
    assert.equal(classifyWorkSession(corrected, "Asia/Colombo", testShift).arrival, "LATE");
    assert.deepEqual(Object.keys(stub.calls.updateData ?? {}), ["startAt"]);
    assert.equal(stub.calls.auditData?.actionType, "ATTENDANCE_DIRECTLY_CORRECTED");
    assert.equal(stub.calls.auditData?.actorId, admin.id);
    assert.deepEqual(stub.calls.auditData?.previousValues, {
      mode: "OFFICE",
      startAt: "2026-06-15T02:30:00.000Z",
      endAt: null,
    });
    assert.equal(stub.calls.auditData?.reason, "Incorrect arrival time");
  });

  it("corrects OUT in Dhaka timezone and leaves unrelated fields unchanged", async () => {
    const stub = createDatabase([makeSession("dhaka", "WFH", "Asia/Dhaka")]);
    const corrected = await correctAdminAttendance(admin, "dhaka", { endAt: "2026-06-15T17:29", reason: "Incorrect departure time" }, stub.database);
    assert.equal(corrected.endAt?.toISOString(), "2026-06-15T11:29:00.000Z");
    assert.equal(classifyWorkSession(corrected, "Asia/Dhaka", testShift).departure, "EARLY_DEPARTURE");
    assert.deepEqual(Object.keys(stub.calls.updateData ?? {}), ["endAt"]);
  });

  it("corrects Office/WFH mode without rewriting timestamps", async () => {
    const stub = createDatabase([makeSession("mode", "OFFICE")]);
    const originalStart = stub.sessionById.get("mode")?.startAt;
    const corrected = await correctAdminAttendance(admin, "mode", { mode: "WFH", reason: "Mode was recorded incorrectly" }, stub.database);
    assert.equal(corrected.mode, "WFH");
    assert.equal(corrected.startAt, originalStart);
    assert.deepEqual(Object.keys(stub.calls.updateData ?? {}), ["mode"]);
  });

  it("uses employee-local wall time through a DST-observing timezone", async () => {
    const stub = createDatabase([makeSession("new-york", "OFFICE", "America/New_York")]);
    const corrected = await correctAdminAttendance(admin, "new-york", { startAt: "2026-03-08T08:31", reason: "Correct DST local time" }, stub.database);
    assert.equal(corrected.startAt.toISOString(), "2026-03-08T12:31:00.000Z");
    assert.equal(classifyWorkSession(corrected, "America/New_York", { ...testShift, workingDays: ["SUNDAY"] }).arrival, "LATE");
  });

  it("keeps multiple same-day sessions separate in the admin result", async () => {
    const first = makeSession("first", "OFFICE");
    const second = { ...makeSession("second", "WFH"), record: first.record };
    const stub = createDatabase([first, second]);
    const result = await listAdminAttendance(admin, { employeeId: first.record.employee.id }, stub.database);
    assert.deepEqual(result.sessions.map((session) => session.id), ["first", "second"]);
  });

  it("summarizes completed time only and retains active mixed-mode session classifications", async () => {
    const completed = { ...makeSession("completed", "OFFICE"), endAt: new Date("2026-06-15T07:30:00.000Z") };
    const active = { ...makeSession("active", "WFH"), startAt: new Date("2026-06-15T09:00:00.000Z"), record: completed.record };
    const stub = createDatabase([completed, active]);
    const result = await listAdminAttendance(admin, { employeeId: completed.record.employee.id }, stub.database);

    assert.equal(result.dailySummaries.length, 1);
    assert.equal(result.dailySummaries[0].day.sessions.length, 2);
    assert.equal(result.dailySummaries[0].day.totalWorkedMs, 5 * 60 * 60 * 1000);
    assert.equal(result.dailySummaries[0].day.sessions[1].status, "ACTIVE");
    assert.equal(result.dailySummaries[0].day.sessions[1].timing?.arrival, "LATE");
  });

  it("groups the same UTC instant under each employee's own local date", async () => {
    const colombo = makeSession("colombo-date", "OFFICE", "Asia/Colombo");
    colombo.startAt = new Date("2026-06-15T18:15:00.000Z");
    const dhaka = makeSession("dhaka-date", "WFH", "Asia/Dhaka");
    dhaka.startAt = new Date("2026-06-15T18:15:00.000Z");
    const stub = createDatabase([colombo, dhaka]);
    const result = await listAdminAttendance(admin, {}, stub.database);
    const datesByTimeZone = new Map(result.dailySummaries.map(({ employee, day }) => [employee.timeZone, day.date]));

    assert.equal(datesByTimeZone.get("Asia/Colombo"), "2026-06-15");
    assert.equal(datesByTimeZone.get("Asia/Dhaka"), "2026-06-16");
  });

  it("rejects impossible local times, invalid input, and OUT before IN", async () => {
    const stub = createDatabase();
    await assert.rejects(correctAdminAttendance(admin, "one", { startAt: "2026-02-30T08:30", reason: "Invalid time" }, stub.database), AdminAttendanceCorrectionError);
    await assert.rejects(correctAdminAttendance(admin, "one", { startAt: "not-a-time", reason: "Invalid time" }, stub.database));
    await assert.rejects(correctAdminAttendance(admin, "one", { endAt: "2026-06-15T07:59", reason: "Invalid interval" }, stub.database), /OUT time cannot be earlier/);
    assert.equal(stub.calls.updateData, undefined);
  });

  it("can close an active session and preserves an open session when OUT is not submitted", async () => {
    const stub = createDatabase([makeSession("active")]);
    const correctedStart = await correctAdminAttendance(admin, "active", { startAt: "2026-06-15T08:20", reason: "Fix arrival" }, stub.database);
    assert.equal(correctedStart.endAt, null);
    const closed = await correctAdminAttendance(admin, "active", { endAt: "2026-06-15T17:30", reason: "Record actual departure" }, stub.database);
    assert.equal(closed.endAt?.toISOString(), "2026-06-15T12:00:00.000Z");
  });

  it("does not reopen a completed session while another session is already open", async () => {
    const completed = { ...makeSession("completed"), endAt: new Date("2026-06-15T07:30:00.000Z") };
    const open = { ...makeSession("open"), record: completed.record };
    const stub = createDatabase([completed, open]);

    await assert.rejects(
      correctAdminAttendance(admin, "completed", { endAt: "", reason: "Reverse mistaken OUT" }, stub.database),
      AdminAttendanceCorrectionError,
    );
    assert.equal(stub.sessionById.get("completed")?.endAt?.toISOString(), "2026-06-15T07:30:00.000Z");
  });

  it("rejects corrections when the requested session does not exist", async () => {
    const stub = createDatabase([]);
    await assert.rejects(correctAdminAttendance(admin, "missing", { endAt: "", reason: "Fix missing session" }, stub.database), AdminAttendanceNotFoundError);
  });

  it("rejects moving a session across employee-local dates without changing history", async () => {
    const first = makeSession("first-day");
    first.record.employee.employee.id = "employee-record-first-day";
    const stub = createDatabase([first], undefined, { hasRawPunchEvidence: true });

    await assert.rejects(
      correctAdminAttendance(admin, "first-day", { startAt: "2026-06-16T08:15", reason: "Fix incorrect date" }, stub.database),
      /cannot move an effective endpoint to another employee-local date while raw punch evidence exists/,
    );
    assert.deepEqual((stub.calls.rawWhere as { employeeId: string }).employeeId, "employee-record-first-day");
    assert.equal(stub.sessionById.get("first-day")?.startAt.toISOString(), "2026-06-15T02:30:00.000Z");
    assert.equal(stub.calls.auditData, undefined);
  });

  it("recalculates original and updated endpoint dates when a session's OUT date changes", async () => {
    const startAt = new Date("2026-06-16T02:30:00.000Z");
    const originalEndAt = new Date("2026-06-17T02:30:00.000Z");
    const rawPunches = [
      { timestamp: startAt, punchType: "IN" as const, workMode: "OFFICE" as const },
    ];
    const stub = createCrossDateCorrectionDatabase({
      startAt,
      endAt: originalEndAt,
      dailyDates: ["2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19"],
      rawPunches,
    });
    const unrelatedBefore = structuredClone(stub.dailyRows[3]);

    const corrected = await correctAdminAttendance(admin, "cross-date-session", {
      endAt: "2026-06-18T09:00",
      reason: "Correct the recorded departure date.",
    }, stub.database);

    assert.equal(corrected.endAt?.toISOString(), "2026-06-18T03:30:00.000Z");
    assert.deepEqual(stub.recalculatedDates, ["2026-06-16", "2026-06-17", "2026-06-18"]);
    assert.equal(stub.dailyRows[0].mode, "OFFICE");
    assert.equal(stub.dailyRows[1].mode, null);
    assert.equal(stub.dailyRows[1].lastOut, null);
    assert.equal(stub.dailyRows[2].mode, "OFFICE");
    assert.equal(stub.dailyRows[2].lastOut?.toISOString(), "2026-06-18T03:30:00.000Z");
    assert.deepEqual(stub.dailyRows[3], unrelatedBefore);
    assert.deepEqual(stub.rawPunches, stub.rawBefore);
  });

  it("recalculates each local date for a mode correction spanning two dates", async () => {
    const startAt = new Date("2026-06-16T02:30:00.000Z");
    const endAt = new Date("2026-06-17T02:30:00.000Z");
    const rawPunches = [
      { timestamp: startAt, punchType: "IN" as const, workMode: "OFFICE" as const },
      { timestamp: endAt, punchType: "OUT" as const, workMode: "OFFICE" as const },
    ];
    const stub = createCrossDateCorrectionDatabase({
      startAt,
      endAt,
      dailyDates: ["2026-06-16", "2026-06-17", "2026-06-18"],
      rawPunches,
    });
    const unrelatedBefore = structuredClone(stub.dailyRows[2]);

    await correctAdminAttendance(admin, "cross-date-session", {
      mode: "WFH",
      reason: "Correct the effective work mode.",
    }, stub.database);

    assert.deepEqual(stub.recalculatedDates, ["2026-06-16", "2026-06-17"]);
    assert.equal(stub.dailyRows[0].mode, "WFH");
    assert.equal(stub.dailyRows[1].mode, "WFH");
    assert.deepEqual(stub.dailyRows[2], unrelatedBefore);
    assert.deepEqual(stub.rawPunches, stub.rawBefore);
  });
});