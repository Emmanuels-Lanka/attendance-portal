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
  record: { employee: { id: string; name: string; employeeCode: string; timeZone: string; countryCode: string; email: string; role: Role; isActive: boolean } };
};

function makeSession(id: string, mode: "OFFICE" | "WFH" = "OFFICE", timeZone = "Asia/Colombo"): TestSession {
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
      },
    },
  };
}

function createDatabase(sessions = [makeSession("one")], linkedUserIds?: string[]) {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const employeeRows = [...new Map(sessions.map((session) => [session.record.employee.id, session.record.employee])).values()];
  const calls: { findWhere?: unknown; employeeSelect?: unknown; updateData?: Record<string, unknown>; auditData?: Record<string, unknown> } = {};
  const workSession = {
    findMany: async (args: { where: unknown; include: unknown }) => {
      calls.findWhere = args.where;
      const queried = [...sessionById.values()];
      return queried.map((session) => ({ ...session }));
    },
    findUnique: async ({ where, select }: { where: { id: string }; select?: unknown }) => {
      const session = sessionById.get(where.id);
      if (session && select) return { record: { employeeId: session.record.employee.id } };
      return session ? { ...session } : null;
    },
    findFirst: async ({ where }: { where: { id?: { not: string }; record: { employeeId: string }; endAt?: null; startAt?: { gte: Date; lt: Date } } }) => {
      const session = [...sessionById.values()].find((item) =>
        item.id !== where.id?.not && item.record.employee.id === where.record.employeeId &&
        (where.endAt === null ? item.endAt === null : Boolean(where.startAt && item.startAt >= where.startAt.gte && item.startAt < where.startAt.lt)),
      );
      return session ? { id: session.id } : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown>; include: unknown }) => {
      calls.updateData = data;
      const session = sessionById.get(where.id);
      if (!session) throw new Error("missing session");
      const updated = { ...session, ...data } as TestSession;
      sessionById.set(where.id, updated);
      return { ...updated };
    },
  };
  const transaction = {
    $queryRaw: async () => [],
    workSession,
    attendanceAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => { calls.auditData = data; return data; },
    },
  };
  const database = {
    user: {
      findMany: async (args: { select: unknown; where?: { id?: string } }) => {
        calls.employeeSelect = args.select;
        return args.where?.id ? employeeRows.filter((employee) => employee.id === args.where?.id) : employeeRows;
      },
    },
    employee: {
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

const admin = { role: Role.ADMIN };

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
    assert.equal(stub.calls.updateData, undefined);
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
    assert.equal(stub.calls.auditData?.actionType, "ADMIN_ATTENDANCE_CORRECTED");
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

  it("rejects moving a session onto another employee-local attendance day without changing history", async () => {
    const first = makeSession("first-day");
    const second = { ...makeSession("second-day"), record: first.record, startAt: new Date("2026-06-16T02:30:00.000Z") };
    const stub = createDatabase([first, second]);

    await assert.rejects(
      correctAdminAttendance(admin, "first-day", { startAt: "2026-06-16T08:15", reason: "Fix incorrect date" }, stub.database),
      /already exists on that employee-local day/,
    );
    assert.equal(stub.sessionById.get("first-day")?.startAt.toISOString(), "2026-06-15T02:30:00.000Z");
    assert.equal(stub.calls.auditData, undefined);
  });
});