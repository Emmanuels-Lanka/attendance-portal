import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import { getAdminAttendanceExceptions } from "./admin-exceptions";

type Employee = {
  id: string;
  name: string;
  email: string;
  employeeCode: string | null;
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

type SessionQueryWhere = {
  endAt?: null;
  record?: { employeeId: { in: string[] } };
  OR?: Array<{ record: { employeeId: string } }>;
  mode?: "OFFICE" | "WFH";
};

function employee(id: string, countryCode: string, timeZone: string, role: Role = Role.EMPLOYEE, isActive = true): Employee {
  return { id, name: id, email: `${id}@example.invalid`, employeeCode: id.toUpperCase(), countryCode, timeZone, role, isActive };
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

function database(employees: Employee[], daySessions: Session[], openSessions: Session[]) {
  const shift = {
    id: "weekday-shift",
    startTime: new Date("1970-01-01T08:00:00.000Z"),
    endTime: new Date("1970-01-01T17:30:00.000Z"),
    gracePeriodMinutes: 10,
    workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
  };
  const user = {
    findMany: async ({ where, select }: { where: { role: Role; isActive: boolean; id?: string }; select: Record<string, boolean> }) => {
      assert.equal("passwordHash" in select, false);
      return employees.filter((item) => item.role === where.role && item.isActive === where.isActive && (!where.id || item.id === where.id));
    },
  };
  const employeeRecord = {
    findMany: async ({ where }: { where: { userId: { in: string[] } } }) => employees
      .filter((item) => where.userId.in.includes(item.id))
      .map((item) => ({
        id: `record-${item.id}`,
        name: `HR ${item.name}`,
        employeeId: item.employeeCode,
        userId: item.id,
        shift: null,
        shiftAssignments: [{ effectiveFrom: new Date("0001-01-01T00:00:00.000Z"), effectiveTo: null, shift }],
      })),
  };
  const workSession = {
    findMany: async ({ where }: { where: SessionQueryWhere }) => {
      if (where.endAt === null) {
        const employeeIds = where.record?.employeeId.in ?? [];
        return openSessions
          .filter((item) => employeeIds.includes(item.record.employee.id) && (!where.mode || item.mode === where.mode))
          .map((item) => ({ id: item.id, record: { employeeId: item.record.employee.id } }));
      }
      const employeeIds = (where.OR ?? []).map((range) => range.record.employeeId);
      return daySessions.filter((item) => employeeIds.includes(item.record.employee.id) && (!where.mode || item.mode === where.mode));
    },
  };
  return { user, employee: employeeRecord, workSession } as never;
}

const admin = { role: Role.ADMIN };

describe("admin attendance exceptions", () => {
  it("counts distinct date exceptions and keeps mixed sessions and durations separate", async () => {
    const sriLanka = employee("lk", "LK", "Asia/Colombo");
    const bangladesh = employee("bd", "BD", "Asia/Dhaka");
    const officeOnly = employee("office-only", "LK", "Asia/Colombo");
    const noAttendance = employee("no-attendance", "BD", "Asia/Dhaka");
    const inactive = employee("inactive", "LK", "Asia/Colombo", Role.EMPLOYEE, false);
    const administrator = employee("admin", "LK", "Asia/Colombo", Role.ADMIN);
    const lateEarly = session("late-early", sriLanka, "OFFICE", "2026-06-15T08:31", "2026-06-15T17:00");
    const onTimeWfh = session("on-time-wfh", sriLanka, "WFH", "2026-06-15T08:10", "2026-06-15T17:30");
    const openOffice = session("open-office", sriLanka, "OFFICE", "2026-06-15T14:00", null);
    const bangladeshWfh = session("bd-wfh", bangladesh, "WFH", "2026-06-15T08:30", "2026-06-15T17:30");
    const officeSession = session("office-session", officeOnly, "OFFICE", "2026-06-15T08:30", "2026-06-15T17:30");
    const openPreviousDate = session("open-previous-date", noAttendance, "OFFICE", "2026-06-14T12:00", null);
    const db = database(
      [sriLanka, bangladesh, officeOnly, noAttendance, inactive, administrator],
      [lateEarly, onTimeWfh, openOffice, bangladeshWfh, officeSession],
      [openOffice, openPreviousDate],
    );

    const result = await getAdminAttendanceExceptions(admin, { date: "2026-06-15" }, db);

    assert.deepEqual(result.metrics, {
      lateArrivals: 3,
      earlyDepartures: 1,
      activeSessions: 2,
      employeesWithoutAttendance: 1,
    });
    const sriLankaEntry = result.entries.find(({ employee: item }) => item.id === sriLanka.id);
    assert.deepEqual(sriLankaEntry?.categories, ["LATE_ARRIVAL", "EARLY_DEPARTURE", "ACTIVE_SESSION"]);
    assert.equal(sriLankaEntry?.day.sessions.length, 3);
    assert.deepEqual(sriLankaEntry?.day.sessions.map(({ session: item }) => item.mode), ["OFFICE", "WFH", "OFFICE"]);
    assert.equal(sriLankaEntry?.day.totalWorkedMs, 17 * 60 * 60 * 1000 + 49 * 60 * 1000);
    assert.equal(sriLankaEntry?.day.sessions[0].timing?.arrival, "LATE");
    assert.equal(sriLankaEntry?.day.sessions[1].timing?.arrival, "ON_TIME");
    assert.equal(sriLankaEntry?.day.sessions[2].status, "ACTIVE");
    const noAttendanceEntry = result.entries.find(({ employee: item }) => item.id === noAttendance.id);
    assert.deepEqual(noAttendanceEntry?.categories, ["ACTIVE_SESSION", "NO_ATTENDANCE"]);
    assert.equal(result.entries.some(({ employee: item }) => item.id === inactive.id || item.id === administrator.id), false);
    assert.equal(JSON.stringify(result).includes("passwordHash"), false);
  });

  it("filters by employee, mode, and exception category without treating other-mode records as missing", async () => {
    const officeOnly = employee("office-only", "LK", "Asia/Colombo");
    const noAttendance = employee("no-attendance", "BD", "Asia/Dhaka");
    const officeSession = session("office-session", officeOnly, "OFFICE", "2026-06-15T08:30", "2026-06-15T17:30");
    const db = database([officeOnly, noAttendance], [officeSession], []);

    const noRecords = await getAdminAttendanceExceptions(admin, {
      date: "2026-06-15",
      employeeId: noAttendance.id,
      mode: "WFH",
      category: "NO_ATTENDANCE",
    }, db);
    const officeIsNotMissing = await getAdminAttendanceExceptions(admin, {
      date: "2026-06-15",
      employeeId: officeOnly.id,
      mode: "WFH",
      category: "NO_ATTENDANCE",
    }, db);

    assert.deepEqual(noRecords.entries.map(({ employee: item }) => item.id), [noAttendance.id]);
    assert.deepEqual(officeIsNotMissing.entries, []);
  });

  it("does not create no-attendance exceptions on optional Sri Lankan Saturdays", async () => {
    const sriLankanEmployee = employee("lk-saturday", "LK", "Asia/Colombo");
    const bangladeshEmployee = employee("bd-saturday", "BD", "Asia/Dhaka");
    const databaseStub = database([sriLankanEmployee, bangladeshEmployee], [], []);

    const saturday = await getAdminAttendanceExceptions(admin, {
      date: "2026-10-31",
      category: "NO_ATTENDANCE",
    }, databaseStub);
    assert.deepEqual(saturday.entries.map(({ employee: item }) => item.id), [bangladeshEmployee.id]);
    assert.equal(saturday.metrics.employeesWithoutAttendance, 1);

    const monday = await getAdminAttendanceExceptions(admin, {
      date: "2026-10-26",
      category: "NO_ATTENDANCE",
    }, databaseStub);
    assert.deepEqual(monday.entries.map(({ employee: item }) => item.id), [sriLankanEmployee.id, bangladeshEmployee.id]);
    assert.equal(monday.metrics.employeesWithoutAttendance, 2);
  });

  it("rejects invalid dates/categories and requires an administrator", async () => {
    const db = database([], [], []);
    await assert.rejects(getAdminAttendanceExceptions(admin, { date: "not-a-date" }, db));
    await assert.rejects(getAdminAttendanceExceptions(admin, { date: "2026-06-15", category: "ABSENT" }, db));
    await assert.rejects(getAdminAttendanceExceptions({ role: Role.EMPLOYEE }, { date: "2026-06-15", category: "NO_ATTENDANCE" }, db), /Administrator access/);
    await assert.rejects(getAdminAttendanceExceptions(null, { date: "2026-06-15" }, db), /Administrator access/);
  });

  it("does not resolve administrator or inactive employee IDs as exception subjects", async () => {
    const administrator = employee("admin", "LK", "Asia/Colombo", Role.ADMIN);
    const inactive = employee("inactive", "LK", "Asia/Colombo", Role.EMPLOYEE, false);
    const db = database([administrator, inactive], [], []);

    const adminResult = await getAdminAttendanceExceptions(admin, { date: "2026-06-15", employeeId: administrator.id }, db);
    const inactiveResult = await getAdminAttendanceExceptions(admin, { date: "2026-06-15", employeeId: inactive.id }, db);

    assert.deepEqual(adminResult.entries, []);
    assert.deepEqual(inactiveResult.entries, []);
  });
});