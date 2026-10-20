import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role } from "@prisma/client";
import { AttendanceLocationAuditError } from "./location-audit";
import {
  AttendanceLocationAuthorizationError,
  listAttendanceLocations,
} from "./location-service";

const storedLocation = { latitude: 6.9271, longitude: 79.8612, accuracy: 12.5 };

function makeDatabase(options: { auditFailure?: boolean; queryFailure?: boolean } = {}) {
  const calls: { employees?: unknown; punches?: unknown } = {};
  const database = {
    auditEvents: [] as unknown[],
    $transaction: async <T>(callback: (transaction: unknown) => Promise<T>) => callback({
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
          if (options.queryFailure) throw new Error("query failed");
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
      attendanceAuditLog: {
        create: async (args: unknown) => {
          if (options.auditFailure) throw new Error("database details with sensitive data");
          (database.auditEvents as unknown[]).push(args);
          return { id: "audit-1" };
        },
      },
    }),
  };
  return { database: database as never, auditEvents: database.auditEvents, calls };
}

describe("attendance location reads", () => {
  it("permits Admin and HR and returns separate punch locations including historical nulls", async () => {
    for (const role of [Role.ADMIN, Role.HR_ADMINISTRATOR]) {
      const stub = makeDatabase();
      const records = await listAttendanceLocations(
        { id: `viewer-${role}`, role },
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
      assert.equal(stub.auditEvents.length, 1);
      const auditEvent = stub.auditEvents[0] as { data: Record<string, unknown> };
      assert.deepEqual(auditEvent.data, {
        actorId: `viewer-${role}`,
        employeeId: null,
        actionType: "ATTENDANCE_LOCATIONS_VIEWED",
        newValues: { viewType: "ADMIN_HR", resultCount: records.length },
      });
      assert.equal(JSON.stringify(auditEvent).includes("latitude"), false);
      assert.equal(JSON.stringify(auditEvent).includes("longitude"), false);
      assert.equal(JSON.stringify(auditEvent).includes("accuracy"), false);
    }
  });

  it("rejects employees, department managers, supervisors, and anonymous callers before querying", async () => {
    for (const actor of [
      { id: "employee", role: Role.EMPLOYEE },
      { id: "manager", role: Role.DEPARTMENT_MANAGER },
      { id: "supervisor", role: Role.SUPERVISOR },
      null,
    ]) {
      const stub = makeDatabase();
      await assert.rejects(
        listAttendanceLocations(actor, { date: "2026-10-05" }, stub.database),
        AttendanceLocationAuthorizationError,
      );
      assert.equal(stub.calls.employees, undefined);
      assert.equal(stub.calls.punches, undefined);
      assert.equal(stub.auditEvents.length, 0);
    }
  });

  it("rejects invalid dates before querying location data", async () => {
    const stub = makeDatabase();
    await assert.rejects(
      listAttendanceLocations({ id: "admin", role: Role.ADMIN }, { date: "2026-02-30" }, stub.database),
      /valid attendance date/,
    );
    assert.equal(stub.calls.employees, undefined);
  });

  it("does not return broad-view locations when the audit write fails", async () => {
    const stub = makeDatabase({ auditFailure: true });
    await assert.rejects(
      listAttendanceLocations(
        { id: "trusted-viewer", role: Role.HR_ADMINISTRATOR },
        { date: "2026-10-05" },
        stub.database,
      ),
      (error: unknown) => error instanceof AttendanceLocationAuditError
        && error.message === "Attendance location access could not be recorded."
        && !error.message.includes("sensitive"),
    );
    assert.ok(stub.calls.punches);
    assert.equal(stub.auditEvents.length, 0);
  });

  it("does not write a successful-view event when the location query fails", async () => {
    const stub = makeDatabase({ queryFailure: true });
    await assert.rejects(
      listAttendanceLocations(
        { id: "trusted-viewer", role: Role.HR_ADMINISTRATOR },
        { date: "2026-10-05" },
        stub.database,
      ),
      /query failed/,
    );
    assert.equal(stub.auditEvents.length, 0);
  });
});
