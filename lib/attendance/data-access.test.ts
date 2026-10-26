import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getEmployeeAttendanceDashboard, getEmployeeAttendanceHistory } from "./service";
import { getEmployeeLocalDayWindow, getEmployeeLocalMonthWindow } from "./timezone";

type TestSession = {
  id: string;
  mode: "OFFICE" | "WFH";
  startAt: Date;
  endAt: Date | null;
};

function dashboardDatabase(activeSession: TestSession | null, sessions: TestSession[]) {
  const filters: Array<Record<string, unknown>> = [];
  const database = {
    employee: { findUnique: async () => ({ shift: null, shiftAssignments: [] }) },
    workSession: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        filters.push(where);
        return activeSession;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        filters.push(where);
        return sessions;
      },
    },
  } as never;
  return { database, filters };
}

function session(id: string, startAt: string, endAt: string | null = null): TestSession {
  return {
    id,
    mode: "OFFICE",
    startAt: new Date(startAt),
    endAt: endAt ? new Date(endAt) : null,
  };
}

describe("employee attendance data access", () => {
  it("reports missing Employee linkage while keeping HR dashboard reads scoped to the session user", async () => {
    const filters: Array<Record<string, unknown>> = [];
    const lookups: Array<{ userId: string }> = [];
    const database = {
      employee: {
        findUnique: async ({ where }: { where: { userId: string } }) => {
          lookups.push(where);
          return null;
        },
      },
      workSession: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          filters.push(where);
          return null;
        },
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          filters.push(where);
          return [];
        },
      },
    } as never;
    const hrUser = { id: "hr-session-user", timeZone: "Asia/Colombo" };

    const dashboard = await getEmployeeAttendanceDashboard(
      hrUser,
      new Date("2026-06-15T12:00:00Z"),
      database,
    );
    await getEmployeeAttendanceHistory(hrUser, database);

    assert.equal(dashboard.employeeRecordFound, false);
    assert.deepEqual(lookups, [{ userId: hrUser.id }, { userId: hrUser.id }]);
    assert.equal(filters.length, 4);
    for (const filter of filters) {
      assert.deepEqual(filter.record, { employeeId: hrUser.id });
    }
  });

  it("scopes dashboard and history queries to the authenticated employee context", async () => {
    const filters: Array<Record<string, unknown>> = [];
    const database = {
      employee: { findUnique: async () => ({ shift: null, shiftAssignments: [] }) },
      workSession: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          filters.push(where);
          return null;
        },
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          filters.push(where);
          return [];
        },
      },
    } as never;
    const employee = { id: "session-user-17", timeZone: "Asia/Colombo" };

    const dashboard = await getEmployeeAttendanceDashboard(employee, new Date("2026-06-15T12:00:00Z"), database);
    await getEmployeeAttendanceHistory(employee, database);

    assert.equal(dashboard.employeeRecordFound, true);
    assert.equal(filters.length, 4);
    for (const filter of filters) {
      assert.deepEqual(filter.record, { employeeId: employee.id });
    }

    const todayQuery = filters[1];
    const window = getEmployeeLocalDayWindow(new Date("2026-06-15T12:00:00Z"), employee.timeZone);
    assert.deepEqual(todayQuery.OR, [
      { startAt: { gte: window.startAt, lt: window.endAt } },
      { endAt: { gte: window.startAt, lt: window.endAt } },
    ]);
    assert.deepEqual(filters[0], { record: { employeeId: employee.id }, endAt: null });
    assert.deepEqual(filters[2]?.record, { employeeId: employee.id });
    const monthWindow = getEmployeeLocalMonthWindow(window.date, employee.timeZone);
    assert.deepEqual(filters[2]?.OR, [{ startAt: { gte: monthWindow.startAt, lt: monthWindow.endAt } }]);
  });

  it("selects today's active session and attendance entries by local start date", async () => {
    const now = new Date("2026-06-15T12:00:00Z");
    const employee = { id: "session-user-17", timeZone: "Asia/Colombo" };
    const todaySession = session("today", "2026-06-15T04:00:00Z");
    const stub = dashboardDatabase(todaySession, [todaySession]);

    const result = await getEmployeeAttendanceDashboard(employee, now, stub.database);
    const window = getEmployeeLocalDayWindow(now, employee.timeZone);

    assert.equal(result.date, "2026-06-15");
    assert.equal(result.activeSession?.id, "today");
    assert.deepEqual(result.day.sessions.map(({ session: item }) => item.id), ["today"]);
    assert.equal(result.day.date, result.date);
    assert.deepEqual(stub.filters[1]?.OR, [
      { startAt: { gte: window.startAt, lt: window.endAt } },
      { endAt: { gte: window.startAt, lt: window.endAt } },
    ]);
    assert.deepEqual(stub.filters[1]?.record, { employeeId: employee.id });
  });

  it("keeps an active session from the previous local day separate from today's attendance", async () => {
    const now = new Date("2026-06-16T03:00:00Z");
    const employee = { id: "session-user-17", timeZone: "Asia/Colombo" };
    const previousDaySession = session("previous-active", "2026-06-15T02:30:00Z");
    const stub = dashboardDatabase(previousDaySession, []);

    const result = await getEmployeeAttendanceDashboard(employee, now, stub.database);

    assert.equal(result.date, "2026-06-16");
    assert.equal(result.activeSession, null);
    assert.equal(result.previousDayActiveSession?.id, "previous-active");
    assert.deepEqual(result.day, { date: "2026-06-16", sessions: [], totalWorkedMs: 0 });
  });

  it("does not treat a previous-local-day session ending today as a completed session today", async () => {
    const now = new Date("2026-06-16T03:00:00Z");
    const employee = { id: "session-user-17", timeZone: "Asia/Colombo" };
    const yesterdaySession = session("yesterday-ended-today", "2026-06-15T02:30:00Z", "2026-06-15T20:00:00Z");
    const stub = dashboardDatabase(null, [yesterdaySession]);

    const result = await getEmployeeAttendanceDashboard(employee, now, stub.database);

    assert.equal(result.date, "2026-06-16");
    assert.deepEqual(result.day, { date: "2026-06-16", sessions: [], totalWorkedMs: 0 });
    assert.equal(result.completedSessionToday, false);
  });

  it("treats a session that started and ended today as completed attendance today", async () => {
    const now = new Date("2026-06-16T03:00:00Z");
    const employee = { id: "session-user-17", timeZone: "Asia/Colombo" };
    const sameDaySession = session("completed-today", "2026-06-16T02:30:00Z", "2026-06-16T03:00:00Z");
    const stub = dashboardDatabase(null, [sameDaySession]);

    const result = await getEmployeeAttendanceDashboard(employee, now, stub.database);

    assert.equal(result.date, "2026-06-16");
    assert.equal(result.day.sessions.length, 1);
    assert.equal(result.completedSessionToday, true);
  });

  it("uses the employee timezone at the UTC boundary between local dates", async () => {
    const now = new Date("2026-06-15T18:30:00Z");
    const employee = { id: "dhaka-employee", timeZone: "Asia/Dhaka" };
    const localTodaySession = session("dhaka-today", "2026-06-15T18:05:00Z");
    const stub = dashboardDatabase(localTodaySession, [localTodaySession]);

    const result = await getEmployeeAttendanceDashboard(employee, now, stub.database);
    const window = getEmployeeLocalDayWindow(now, employee.timeZone);

    assert.equal(result.date, "2026-06-16");
    assert.equal(result.activeSession?.id, "dhaka-today");
    assert.deepEqual(stub.filters[1]?.OR, [
      { startAt: { gte: window.startAt, lt: window.endAt } },
      { endAt: { gte: window.startAt, lt: window.endAt } },
    ]);
    assert.equal(result.day.date, "2026-06-16");
  });
});