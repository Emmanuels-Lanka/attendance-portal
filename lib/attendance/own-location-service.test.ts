import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role } from "@prisma/client";
import { AttendanceLocationAuditError } from "./location-audit";
import {
  listOwnAttendanceLocations,
  OwnAttendanceLocationAuthorizationError,
} from "./own-location-service";

function makeDatabase(options: { employeeRecordId?: string | null; punches?: unknown[]; auditFailure?: boolean; queryFailure?: boolean } = {}) {
  const calls: { employee?: unknown; punches?: unknown } = {};
  const database = {
    auditEvents: [] as unknown[],
    $transaction: async <T>(callback: (transaction: unknown) => Promise<T>) => callback({
      employee: {
        findUnique: async (args: unknown) => {
          calls.employee = args;
          return options.employeeRecordId === null
            ? null
            : { id: options.employeeRecordId ?? "employee-record-self" };
        },
      },
      attendanceRaw: {
        findMany: async (args: unknown) => {
          calls.punches = args;
          if (options.queryFailure) throw new Error("query failed");
          return options.punches ?? [
            {
              id: "punch-out",
              timestamp: new Date("2026-10-20T11:30:00.000Z"),
              punchType: "OUT",
              location: { latitude: 6.9272, longitude: 79.8613, accuracy: 12.5 },
            },
            {
              id: "punch-in",
              timestamp: new Date("2026-10-20T02:30:00.000Z"),
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

describe("employee-owned attendance locations", () => {
  it("resolves the Employee row from the authenticated user and queries only that row's punches", async () => {
    const stub = makeDatabase();
    const records = await listOwnAttendanceLocations({
      id: "authenticated-user",
      role: Role.EMPLOYEE,
      timeZone: "Asia/Colombo",
    }, stub.database);

    assert.deepEqual(stub.calls.employee, {
      where: { userId: "authenticated-user" },
      select: { id: true },
    });
    assert.deepEqual(stub.calls.punches, {
      where: { employeeId: "employee-record-self" },
      select: { id: true, timestamp: true, punchType: true, location: true },
      orderBy: [{ timestamp: "desc" }, { id: "asc" }],
      take: 501,
    });
    assert.deepEqual(records.records, [
      {
        id: "punch-out",
        timestamp: new Date("2026-10-20T11:30:00.000Z"),
        punchType: "OUT",
        location: { latitude: 6.9272, longitude: 79.8613, accuracy: 12.5 },
      },
      {
        id: "punch-in",
        timestamp: new Date("2026-10-20T02:30:00.000Z"),
        punchType: "IN",
        location: null,
      },
    ]);
    assert.equal(records.employeeRecordFound, true);
    assert.equal(records.limitReached, false);
    assert.deepEqual(stub.auditEvents, [{
      data: {
        actorId: "authenticated-user",
        employeeId: null,
        actionType: "ATTENDANCE_LOCATIONS_VIEWED",
        newValues: { viewType: "SELF", resultCount: records.records.length },
      },
      select: { id: true },
    }]);
    assert.equal(JSON.stringify(stub.auditEvents).includes("latitude"), false);
    assert.equal(JSON.stringify(stub.auditEvents).includes("longitude"), false);
    assert.equal(JSON.stringify(stub.auditEvents).includes("accuracy"), false);
  });

  it("does not allow supplied employee identifiers to change the session-derived query scope", async () => {
    const stub = makeDatabase();
    const actor = {
      id: "authenticated-user",
      role: Role.EMPLOYEE,
      timeZone: "Asia/Colombo",
      employeeId: "attacker-selected-employee",
    };
    await listOwnAttendanceLocations(actor, stub.database);

    assert.deepEqual(stub.calls.employee, {
      where: { userId: "authenticated-user" },
      select: { id: true },
    });
    assert.deepEqual(stub.calls.punches, {
      where: { employeeId: "employee-record-self" },
      select: { id: true, timestamp: true, punchType: true, location: true },
      orderBy: [{ timestamp: "desc" }, { id: "asc" }],
      take: 501,
    });
    assert.deepEqual(stub.auditEvents[0], {
      data: {
        actorId: "authenticated-user",
        employeeId: null,
        actionType: "ATTENDANCE_LOCATIONS_VIEWED",
        newValues: { viewType: "SELF", resultCount: 2 },
      },
      select: { id: true },
    });
  });

  it("returns an unavailable empty result when the employee account has no linked record", async () => {
    const stub = makeDatabase({ employeeRecordId: null });
    const result = await listOwnAttendanceLocations({
      id: "legacy-account",
      role: Role.EMPLOYEE,
      timeZone: "Asia/Colombo",
    }, stub.database);

    assert.deepEqual(result, { employeeRecordFound: false, records: [], limitReached: false });
    assert.equal(stub.calls.punches, undefined);
    assert.deepEqual(stub.auditEvents[0], {
      data: {
        actorId: "legacy-account",
        employeeId: null,
        actionType: "ATTENDANCE_LOCATIONS_VIEWED",
        newValues: { viewType: "SELF", resultCount: 0 },
      },
      select: { id: true },
    });
  });

  it("keeps usable coordinates but marks absent or malformed accuracy unavailable", async () => {
    const stub = makeDatabase({
      punches: [
        {
          id: "without-accuracy",
          timestamp: new Date("2026-10-20T11:30:00.000Z"),
          punchType: "IN",
          location: { latitude: 6.9, longitude: 79.8 },
        },
        {
          id: "bad-accuracy",
          timestamp: new Date("2026-10-20T11:31:00.000Z"),
          punchType: "OUT",
          location: { latitude: 6.9, longitude: 79.8, accuracy: "unknown" },
        },
        {
          id: "invalid-coordinates",
          timestamp: new Date("2026-10-20T11:32:00.000Z"),
          punchType: "OUT",
          location: { latitude: 91, longitude: 79.8, accuracy: 2 },
        },
        {
          id: "legacy-null",
          timestamp: new Date("2026-10-20T11:33:00.000Z"),
          punchType: "IN",
          location: null,
        },
      ],
    });
    const result = await listOwnAttendanceLocations({
      id: "authenticated-user",
      role: Role.EMPLOYEE,
      timeZone: "Asia/Colombo",
    }, stub.database);

    assert.deepEqual(result.records.map(({ location }) => location), [
      { latitude: 6.9, longitude: 79.8, accuracy: null },
      { latitude: 6.9, longitude: 79.8, accuracy: null },
      null,
      null,
    ]);
  });

  it("limits the returned history to 500 while detecting older records", async () => {
    const stub = makeDatabase({
      punches: Array.from({ length: 501 }, (_, index) => ({
        id: `punch-${index}`,
        timestamp: new Date(Date.UTC(2026, 9, 20, 0, -index)),
        punchType: index % 2 === 0 ? "IN" : "OUT",
        location: null,
      })),
    });
    const result = await listOwnAttendanceLocations({
      id: "authenticated-user",
      role: Role.EMPLOYEE,
      timeZone: "Asia/Colombo",
    }, stub.database);

    assert.equal(result.records.length, 500);
    assert.equal(result.limitReached, true);
  });

  it("rejects non-employees before looking up an Employee or querying punches", async () => {
    for (const actor of [
      { id: "admin", role: Role.ADMIN, timeZone: "UTC" },
      { id: "hr", role: Role.HR_ADMINISTRATOR, timeZone: "UTC" },
      { id: "manager", role: Role.DEPARTMENT_MANAGER, timeZone: "UTC" },
      { id: "supervisor", role: Role.SUPERVISOR, timeZone: "UTC" },
      null,
    ]) {
      const stub = makeDatabase();
      await assert.rejects(
        listOwnAttendanceLocations(actor, stub.database),
        OwnAttendanceLocationAuthorizationError,
      );
      assert.equal(stub.calls.employee, undefined);
      assert.equal(stub.calls.punches, undefined);
      assert.equal(stub.auditEvents.length, 0);
    }
  });

  it("does not return self-view locations when the audit write fails", async () => {
    const stub = makeDatabase({ auditFailure: true });
    await assert.rejects(
      listOwnAttendanceLocations({
        id: "authenticated-user",
        role: Role.EMPLOYEE,
        timeZone: "Asia/Colombo",
      }, stub.database),
      (error: unknown) => error instanceof AttendanceLocationAuditError
        && error.message === "Attendance location access could not be recorded."
        && !error.message.includes("sensitive"),
    );
    assert.ok(stub.calls.punches);
    assert.equal(stub.auditEvents.length, 0);
  });

  it("does not write a successful-view event when the self-location query fails", async () => {
    const stub = makeDatabase({ queryFailure: true });
    await assert.rejects(
      listOwnAttendanceLocations({
        id: "authenticated-user",
        role: Role.EMPLOYEE,
        timeZone: "Asia/Colombo",
      }, stub.database),
      /query failed/,
    );
    assert.equal(stub.auditEvents.length, 0);
  });
});
