import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role } from "@prisma/client";
import {
  DailyAttendanceAuthorizationError,
  listCalculatedDailyAttendance,
} from "./daily-read";

const persistedRecord = {
  id: "daily-1",
  date: new Date("2026-10-05T00:00:00.000Z"),
  firstIn: new Date("2026-10-04T23:00:00.000Z"),
  lastOut: new Date("2026-10-05T08:00:00.000Z"),
  workingHours: { toString: () => "8.00" },
  lateMinutes: 0,
  earlyMinutes: 0,
  overtimeHours: null,
  status: "PRESENT",
  employee: {
    id: "employee-1",
    name: "Alex Employee",
    employeeId: "E-1",
    user: { timeZone: "Asia/Colombo" },
    department: { name: "Operations" },
  },
  shift: { name: "Day Shift" },
};

function makeDatabase(total = 1, records = [persistedRecord]) {
  const calls: { count?: unknown; findMany?: unknown; employees?: unknown; departments?: unknown } = {};
  const database = {
    attendanceDaily: {
      count: async (args: unknown) => {
        calls.count = args;
        return total;
      },
      findMany: async (args: unknown) => {
        calls.findMany = args;
        return records;
      },
    },
    employee: {
      findUnique: async () => ({ departmentId: "department-1" }),
      findMany: async (args: unknown) => {
        calls.employees = args;
        return [{ id: "employee-1", name: "Alex Employee", employeeId: "E-1" }];
      },
    },
    department: {
      findMany: async (args: unknown) => {
        calls.departments = args;
        return [{ id: "department-1", name: "Operations" }];
      },
    },
  } as never;
  return { database, calls };
}

const admin = { role: Role.ADMIN };

describe("calculated daily attendance read service", () => {
  it("returns persisted calculated fields and the stored status", async () => {
    const stub = makeDatabase();
    const result = await listCalculatedDailyAttendance(admin, {}, stub.database);

    assert.equal(result.total, 1);
    assert.equal(result.records[0].employee.name, "Alex Employee");
    assert.equal(result.records[0].shift?.name, "Day Shift");
    assert.equal(result.records[0].firstIn?.toISOString(), "2026-10-04T23:00:00.000Z");
    assert.equal(result.records[0].lastOut?.toISOString(), "2026-10-05T08:00:00.000Z");
    assert.equal(result.records[0].workingHours?.toString(), "8.00");
    assert.equal(result.records[0].lateMinutes, 0);
    assert.equal(result.records[0].earlyMinutes, 0);
    assert.equal(result.records[0].status, "PRESENT");
    assert.equal(result.records[0].overtimeHours, null);
  });

  it("applies employee, date, department, and implemented-status filters", async () => {
    const stub = makeDatabase();
    await listCalculatedDailyAttendance(admin, {
      date: "2026-10-05",
      employeeId: "employee-1",
      departmentId: "department-1",
      status: "LATE",
    }, stub.database);

    const expectedWhere = {
      date: new Date("2026-10-05T00:00:00.000Z"),
      employeeId: "employee-1",
      employee: { AND: [{ departmentId: "department-1" }] },
      status: "LATE",
    };
    assert.deepEqual(stub.calls.count, { where: expectedWhere });
    assert.deepEqual((stub.calls.findMany as { where: unknown }).where, expectedWhere);
  });

  it("allows HR to read employee attendance and scopes both choices and records away from privileged accounts", async () => {
    const stub = makeDatabase();
    await listCalculatedDailyAttendance({ role: Role.HR_ADMINISTRATOR }, {
      date: "2026-10-05",
      employeeId: "privileged-employee-record",
      departmentId: "department-1",
    }, stub.database);

    const employeeScope = { user: { is: { role: "EMPLOYEE" } } };
    assert.deepEqual(stub.calls.employees, {
      where: employeeScope,
      select: { id: true, name: true, employeeId: true },
      orderBy: { name: "asc" },
    });
    assert.deepEqual(stub.calls.count, {
      where: {
        date: new Date("2026-10-05T00:00:00.000Z"),
        employeeId: "privileged-employee-record",
        employee: { AND: [employeeScope, { departmentId: "department-1" }] },
      },
    });
  });

  it("limits Department Managers to their assigned department even when another department is submitted", async () => {
    const stub = makeDatabase();
    await listCalculatedDailyAttendance({ id: "manager-1", role: Role.DEPARTMENT_MANAGER }, {
      date: "2026-10-05",
      departmentId: "department-2",
    }, stub.database);

    assert.deepEqual(stub.calls.count, {
      where: {
        date: new Date("2026-10-05T00:00:00.000Z"),
        employee: {
          AND: [
            { departmentId: "department-1", user: { is: { role: "EMPLOYEE" } } },
            { departmentId: "department-2" },
          ],
        },
      },
    });
    assert.deepEqual(stub.calls.departments, {
      where: { id: "department-1" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
  });

  it("limits Supervisors to assigned employee attendance and department choices", async () => {
    const stub = makeDatabase();
    await listCalculatedDailyAttendance({ id: "supervisor-1", role: Role.SUPERVISOR }, {
      date: "2026-10-05",
      status: "MISSING_PUNCH",
    }, stub.database);

    const assignedEmployeeScope = {
      supervisor: { userId: "supervisor-1", user: { role: "SUPERVISOR", isActive: true } },
      user: { is: { role: "EMPLOYEE" } },
    };
    assert.deepEqual(stub.calls.count, {
      where: {
        date: new Date("2026-10-05T00:00:00.000Z"),
        employee: { AND: [assignedEmployeeScope] },
        status: "MISSING_PUNCH",
      },
    });
    assert.deepEqual(stub.calls.employees, {
      where: assignedEmployeeScope,
      select: { id: true, name: true, employeeId: true },
      orderBy: { name: "asc" },
    });
    assert.deepEqual(stub.calls.departments, {
      where: { employees: { some: assignedEmployeeScope } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
  });

  it("returns a persisted status value unchanged without inventing status data", async () => {
    const futurePersistedStatus = { ...persistedRecord, status: "HOLIDAY" };
    const stub = makeDatabase(1, [futurePersistedStatus]);
    const result = await listCalculatedDailyAttendance(admin, {}, stub.database);

    assert.equal(result.records[0].status, "HOLIDAY");
  });

  it("uses bounded pagination and clamps a page beyond the final page", async () => {
    const stub = makeDatabase(51);
    const result = await listCalculatedDailyAttendance(admin, { page: 3 }, stub.database);

    assert.equal(result.page, 2);
    assert.equal(result.pageCount, 2);
    assert.deepEqual(stub.calls.findMany, {
      where: {},
      select: {
        id: true,
        date: true,
        firstIn: true,
        lastOut: true,
        workingHours: true,
        lateMinutes: true,
        earlyMinutes: true,
        overtimeHours: true,
        status: true,
        employee: {
          select: {
            id: true,
            name: true,
            employeeId: true,
            user: { select: { timeZone: true } },
            department: { select: { name: true } },
          },
        },
        shift: { select: { name: true } },
      },
      orderBy: [{ date: "desc" }, { employee: { name: "asc" } }],
      skip: 50,
      take: 50,
    });
  });

  it("rejects unauthorized reads before querying any data", async () => {
    const stub = makeDatabase();
    await assert.rejects(listCalculatedDailyAttendance({ role: Role.EMPLOYEE }, {}, stub.database), DailyAttendanceAuthorizationError);
    await assert.rejects(listCalculatedDailyAttendance(null, {}, stub.database), DailyAttendanceAuthorizationError);
    assert.deepEqual(stub.calls, {});
  });

  it("accepts persisted SRS statuses and rejects invalid dates and unknown statuses", async () => {
    const stub = makeDatabase();
    await assert.rejects(listCalculatedDailyAttendance(admin, { date: "2026-02-30" }, stub.database));
    await listCalculatedDailyAttendance(admin, { status: "HOLIDAY" }, stub.database);
    await listCalculatedDailyAttendance(admin, { status: "ABSENT" }, stub.database);
    await listCalculatedDailyAttendance(admin, { status: "LEAVE" }, stub.database);
    await listCalculatedDailyAttendance(admin, { status: "WFH" }, stub.database);
    await assert.rejects(listCalculatedDailyAttendance(admin, { status: "FUTURE_STATUS" }, stub.database));
    assert.deepEqual(stub.calls.count, { where: { status: "WFH" } });
  });

  it("rejects invalid dates before querying any data", async () => {
    const stub = makeDatabase();
    await assert.rejects(listCalculatedDailyAttendance(admin, { date: "2026-02-30" }, stub.database));
    assert.deepEqual(stub.calls, {});
  });
});
