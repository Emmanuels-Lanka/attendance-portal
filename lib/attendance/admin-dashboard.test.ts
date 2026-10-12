import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import { getAdminAttendanceSummary } from "./admin-dashboard";

type Employee = {
  id: string;
  name: string;
  email: string;
  employeeCode: string;
  countryCode: string;
  timeZone: string;
  role: Role;
  isActive: boolean;
};

type Session = {
  id: string;
  mode: "OFFICE" | "WFH";
  startAt: Date;
  endAt: Date | null;
  record: { employee: Employee };
};

function makeEmployee(id: string, countryCode: string, timeZone: string): Employee {
  return { id, name: id, email: `${id}@example.invalid`, employeeCode: id.toUpperCase(), countryCode, timeZone, role: Role.EMPLOYEE, isActive: true };
}

function session(id: string, employee: Employee, mode: Session["mode"], start: string, end: string | null): Session {
  return {
    id,
    mode,
    startAt: fromZonedTime(start, employee.timeZone),
    endAt: end ? fromZonedTime(end, employee.timeZone) : null,
    record: { employee },
  };
}

function createDatabase(employees: Employee[], daySessions: Session[], openSessions: Session[]) {
  const queries: Record<string, unknown>[] = [];
  const database = {
    user: {
      findMany: async (args: { where: { role: Role; isActive: boolean; id?: string }; select: Record<string, boolean> }) => {
        queries.push(args.where);
        assert.equal("passwordHash" in args.select, false);
        return employees.filter((employee) => employee.role === args.where.role && employee.isActive === args.where.isActive && (!args.where.id || employee.id === args.where.id));
      },
    },
    employee: {
      findMany: async ({ where }: { where: { userId: { in: string[] } } }) => where.userId.in.map((userId) => ({
        id: `record-${userId}`,
        name: `HR ${userId}`,
        employeeId: `HR-${userId}`,
        userId,
      })),
    },
    workSession: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        queries.push(args.where);
        if ("OR" in args.where) return daySessions.filter((item) => args.where.mode === undefined || item.mode === args.where.mode);
          return openSessions
            .filter((item) => args.where.mode === undefined || item.mode === args.where.mode)
            .map((item) => ({ mode: item.mode, startAt: item.startAt, record: { employeeId: item.record.employee.id } }));
      },
    },
  } as never;
  return { database, queries };
}

const admin = { role: Role.ADMIN };

describe("admin attendance summary dashboard", () => {
  it("counts selected-date attendance, late/early, completed, active, and no-record employees", async () => {
    const sriLanka = makeEmployee("lk", "LK", "Asia/Colombo");
    const bangladesh = makeEmployee("bd", "BD", "Asia/Dhaka");
    const noAttendance = makeEmployee("no-attendance", "US", "America/New_York");
    const daySessions = [
      session("office-late-early", sriLanka, "OFFICE", "2026-06-15T08:31", "2026-06-15T12:00"),
      session("wfh-second", sriLanka, "WFH", "2026-06-15T13:00", "2026-06-15T17:30"),
      session("dhaka-on-time", bangladesh, "WFH", "2026-06-15T08:30", "2026-06-15T17:30"),
    ];
    const openSession = session("open-yesterday", noAttendance, "OFFICE", "2026-06-14T08:30", null);
    const stub = createDatabase([sriLanka, bangladesh, noAttendance], daySessions, [openSession]);

    const result = await getAdminAttendanceSummary(admin, { date: "2026-06-15" }, stub.database);

    assert.deepEqual(result.metrics, {
      totalEmployees: 3,
      withAttendance: 2,
      withoutAttendance: 1,
      lateArrivals: 1,
      earlyDepartures: 1,
      completed: 2,
      activeNow: 1,
    });
    const sriLankaDay = result.employees.find(({ employee }) => employee.id === sriLanka.id)?.day;
    assert.equal(sriLankaDay?.sessions.length, 2);
    assert.equal(sriLankaDay?.totalWorkedMs, 7 * 60 * 60 * 1000 + 59 * 60 * 1000);
    assert.deepEqual(sriLankaDay?.sessions.map(({ session: item }) => item.mode), ["OFFICE", "WFH"]);
    const linkedEmployee = result.employees.find(({ employee }) => employee.id === sriLanka.id)?.employee;
    assert.deepEqual(linkedEmployee?.employeeRecord, {
      id: `record-${sriLanka.id}`,
      name: `HR ${sriLanka.id}`,
      employeeId: `HR-${sriLanka.id}`,
    });
    assert.equal(linkedEmployee?.id, sriLanka.id);
  });

  it("uses employee-local selected dates for employees whose UTC instant differs by timezone", async () => {
    const sriLanka = makeEmployee("lk-date", "LK", "Asia/Colombo");
    const bangladesh = makeEmployee("bd-date", "BD", "Asia/Dhaka");
    const sharedUtcSession: Session[] = [
      { ...session("shared-lk", sriLanka, "OFFICE", "2026-06-15T23:00", "2026-06-16T00:00"), startAt: new Date("2026-06-15T18:15:00Z"), endAt: new Date("2026-06-15T19:15:00Z") },
      { ...session("shared-bd", bangladesh, "WFH", "2026-06-16T00:00", "2026-06-16T01:00"), startAt: new Date("2026-06-15T18:15:00Z"), endAt: new Date("2026-06-15T19:15:00Z") },
    ];
    const stub = createDatabase([sriLanka, bangladesh], sharedUtcSession, []);

    const june15 = await getAdminAttendanceSummary(admin, { date: "2026-06-15" }, stub.database);
    assert.deepEqual(june15.employees.map(({ employee, day }) => [employee.id, day.sessions.length]), [["lk-date", 1], ["bd-date", 0]]);

    const june16 = await getAdminAttendanceSummary(admin, { date: "2026-06-16" }, stub.database);
    assert.deepEqual(june16.employees.map(({ employee, day }) => [employee.id, day.sessions.length]), [["lk-date", 0], ["bd-date", 1]]);
  });

  it("allows HR dashboard summaries while excluding privileged account attendance", async () => {
    const employee = makeEmployee("employee", "LK", "Asia/Colombo");
    const administrator = { ...makeEmployee("admin", "LK", "Asia/Colombo"), role: Role.ADMIN };
    const stub = createDatabase([employee, administrator], [session("employee-session", employee, "OFFICE", "2026-06-15T08:30", "2026-06-15T17:30")], []);

    const result = await getAdminAttendanceSummary({ role: Role.HR_ADMINISTRATOR }, { date: "2026-06-15" }, stub.database);

    assert.equal(result.metrics.totalEmployees, 1);
    assert.deepEqual(result.employees.map(({ employee: item }) => item.id), ["employee"]);
    assert.deepEqual(stub.queries[0], { role: "EMPLOYEE", isActive: true });
  });

  it("requires admin authorization and rejects invalid selected dates", async () => {
    const stub = createDatabase([], [], []);
    await assert.rejects(getAdminAttendanceSummary({ role: Role.EMPLOYEE }, { date: "2026-06-15" }, stub.database), /Administrator access/);
    await assert.rejects(getAdminAttendanceSummary(null, { date: "2026-06-15" }, stub.database), /Administrator access/);
    await assert.rejects(getAdminAttendanceSummary(admin, { date: "not-a-date" }, stub.database));
  });
});