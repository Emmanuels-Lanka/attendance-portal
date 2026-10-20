import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role } from "@prisma/client";
import {
  AttendanceLocationAuthorizationError,
  listAttendanceLocations,
} from "./location-service";

const storedLocation = { latitude: 6.9271, longitude: 79.8612, accuracy: 12.5 };

function makeDatabase() {
  const calls: { employees?: unknown; punches?: unknown } = {};
  const database = {
    employee: {
      findMany: async (args: unknown) => {
        calls.employees = args;
        return [{
          id: "employee-record-1",
          name: "Alex Employee",
          employeeId: "E-1",
          user: { timeZone: "Asia/Colombo" },
        }];
      },
    },
    attendanceRaw: {
      findMany: async (args: unknown) => {
        calls.punches = args;
        return [
          {
            id: "raw-out",
            employeeId: "employee-record-1",
            timestamp: new Date("2026-10-05T11:30:00.000Z"),
            punchType: "OUT",
            location: storedLocation,
          },
          {
            id: "raw-in",
            employeeId: "employee-record-1",
            timestamp: new Date("2026-10-05T02:30:00.000Z"),
            punchType: "IN",
            location: null,
          },
        ];
      },
    },
  } as never;
  return { database, calls };
}

describe("attendance location reads", () => {
  it("permits Admin and HR and returns separate punch locations including historical nulls", async () => {
    for (const role of [Role.ADMIN, Role.HR_ADMINISTRATOR]) {
      const stub = makeDatabase();
      const records = await listAttendanceLocations(
        { role },
        { date: "2026-10-05", employeeId: "employee-record-1", departmentId: "department-1" },
        stub.database,
      );

      assert.deepEqual(records.map(({ punchType, location }) => [punchType, location]), [
        ["OUT", storedLocation],
        ["IN", null],
      ]);
      assert.deepEqual(stub.calls.employees, {
        where: {
          user: { is: { role: "EMPLOYEE" } },
          id: "employee-record-1",
          departmentId: "department-1",
        },
        select: {
          id: true,
          name: true,
          employeeId: true,
          user: { select: { timeZone: true } },
        },
      });
      const punchQuery = stub.calls.punches as { where: { OR: Array<{ employeeId: string; timestamp: { gte: Date; lt: Date } }> } };
      assert.equal(punchQuery.where.OR[0].employeeId, "employee-record-1");
      assert.equal(punchQuery.where.OR[0].timestamp.gte.toISOString(), "2026-10-04T18:30:00.000Z");
      assert.equal(punchQuery.where.OR[0].timestamp.lt.toISOString(), "2026-10-05T18:30:00.000Z");
    }
  });

  it("rejects employees, department managers, supervisors, and anonymous callers before querying", async () => {
    for (const actor of [
      { role: Role.EMPLOYEE },
      { role: Role.DEPARTMENT_MANAGER },
      { role: Role.SUPERVISOR },
      null,
    ]) {
      const stub = makeDatabase();
      await assert.rejects(
        listAttendanceLocations(actor, { date: "2026-10-05" }, stub.database),
        AttendanceLocationAuthorizationError,
      );
      assert.equal(stub.calls.employees, undefined);
      assert.equal(stub.calls.punches, undefined);
    }
  });

  it("rejects invalid dates before querying location data", async () => {
    const stub = makeDatabase();
    await assert.rejects(
      listAttendanceLocations({ role: Role.ADMIN }, { date: "2026-02-30" }, stub.database),
      /valid attendance date/,
    );
    assert.equal(stub.calls.employees, undefined);
  });
});
