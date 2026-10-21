import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role } from "@prisma/client";
import { AttendanceLocationAuditError } from "./location-audit";
import {
  AttendanceLocationAuthorizationError,
  listAttendanceLocations,
} from "./location-service";
import { attendanceLocationPunchLabel, hasPoorGpsAccuracy, POOR_GPS_ACCURACY_THRESHOLD_METERS } from "./location-presentation";

const storedLocation = { latitude: 6.9271, longitude: 79.8612, accuracy: 12.5 };

function makeDatabase(options: { auditFailure?: boolean; queryFailure?: boolean; sessions?: unknown[]; punches?: unknown[] } = {}) {
  const calls: { employees?: unknown; punches?: unknown; sessions?: unknown } = {};
  let auditAttempts = 0;
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
            user: { id: "employee-user-1", timeZone: "Asia/Colombo" },
          }];
        },
      },
      attendanceRaw: {
        findMany: async (args: unknown) => {
          calls.punches = args;
          if (options.queryFailure) throw new Error("query failed");
          return options.punches ?? [
            {
              id: "raw-out",
              employeeId: "employee-record-1",
              timestamp: new Date("2026-10-05T11:30:00.000Z"),
              punchType: "OUT",
              workMode: null,
              location: storedLocation,
            },
            {
              id: "raw-in",
              employeeId: "employee-record-1",
              timestamp: new Date("2026-10-05T02:30:00.000Z"),
              punchType: "IN",
              workMode: null,
              location: null,
            },
          ];
        },
      },
      workSession: {
        findMany: async (args: unknown) => {
          calls.sessions = args;
          return options.sessions ?? [];
        },
      },
      attendanceAuditLog: {
        create: async (args: unknown) => {
          auditAttempts += 1;
          if (options.auditFailure) throw new Error("database details with sensitive data");
          (database.auditEvents as unknown[]).push(args);
          return { id: "audit-1" };
        },
      },
    }),
  };
  return { database: database as never, auditEvents: database.auditEvents, calls, getAuditAttempts: () => auditAttempts };
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

      assert.deepEqual(records.records.map(({ punchType, workMode, location }) => [punchType, workMode, location]), [
        ["OUT", null, storedLocation],
        ["IN", null, null],
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
          user: { select: { id: true, timeZone: true } },
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
        newValues: {
          viewType: "ADMIN_HR",
          resultCount: records.records.length,
          filters: {
            date: "2026-10-05",
            employeeId: "employee-record-1",
            departmentId: "department-1",
          },
        },
      });
      assert.equal(JSON.stringify(auditEvent).includes("latitude"), false);
      assert.equal(JSON.stringify(auditEvent).includes("longitude"), false);
      assert.equal(JSON.stringify(auditEvent).includes("accuracy"), false);
      assert.equal(JSON.stringify(auditEvent).includes("rawLocationJson"), false);
      assert.equal(JSON.stringify(auditEvent).includes("mapUrl"), false);
      assert.equal(JSON.stringify(auditEvent).includes("maps.google.com"), false);
      assert.equal(JSON.stringify(auditEvent).includes("6.9271"), false);
      assert.equal(JSON.stringify(auditEvent).includes("79.8612"), false);
      assert.equal(JSON.stringify(auditEvent).includes("12.5"), false);
      assert.equal(stub.getAuditAttempts(), 1);
    }
  });

  it("infers a historical mode only from one exact related-session timestamp match", async () => {
    const startAt = new Date("2026-10-05T02:30:00.000Z");
    const endAt = new Date("2026-10-05T11:30:00.000Z");
    const stub = makeDatabase({
      sessions: [
        { mode: "WFH", startAt, endAt: null, record: { employeeId: "employee-user-1" } },
        { mode: "OFFICE", startAt: new Date("2026-10-04T02:30:00.000Z"), endAt, record: { employeeId: "employee-user-1" } },
      ],
    });
    const records = await listAttendanceLocations(
      { id: "admin", role: Role.ADMIN },
      { date: "2026-10-05" },
      stub.database,
    );

    assert.deepEqual(records.records.map(({ punchType, workMode }) => [punchType, workMode]), [
      ["OUT", "OFFICE"],
      ["IN", "WFH"],
    ]);
    assert.ok(stub.calls.sessions);
  });

  it("keeps a stored work mode after session corrections and leaves ambiguous legacy mode unknown", async () => {
    const startAt = new Date("2026-10-05T02:30:00.000Z");
    const stub = makeDatabase({
      sessions: [
        { mode: "OFFICE", startAt, endAt: null, record: { employeeId: "employee-user-1" } },
        { mode: "WFH", startAt, endAt: null, record: { employeeId: "employee-user-1" } },
      ],
      punches: [
        {
          id: "stored-wfh",
          employeeId: "employee-record-1",
          timestamp: startAt,
          punchType: "IN",
          workMode: "WFH",
          location: storedLocation,
        },
        {
          id: "ambiguous-legacy",
          employeeId: "employee-record-1",
          timestamp: startAt,
          punchType: "IN",
          workMode: null,
          location: null,
        },
      ],
    });
    const records = await listAttendanceLocations(
      { id: "admin", role: Role.ADMIN },
      { date: "2026-10-05" },
      stub.database,
    );

    assert.deepEqual(records.records.map(({ workMode }) => workMode), ["WFH", null]);
  });

  it("keeps historical punches readable when accuracy is absent or malformed", async () => {
    const stub = makeDatabase({
      punches: [
        {
          id: "missing-accuracy",
          employeeId: "employee-record-1",
          timestamp: new Date("2026-10-05T02:30:00.000Z"),
          punchType: "IN",
          workMode: "OFFICE",
          location: { latitude: 6.9, longitude: 79.8 },
        },
        {
          id: "malformed-accuracy",
          employeeId: "employee-record-1",
          timestamp: new Date("2026-10-05T11:30:00.000Z"),
          punchType: "OUT",
          workMode: "OFFICE",
          location: { latitude: 6.9, longitude: 79.8, accuracy: "unknown" },
        },
        {
          id: "missing-location",
          employeeId: "employee-record-1",
          timestamp: new Date("2026-10-05T12:00:00.000Z"),
          punchType: "OUT",
          workMode: "OFFICE",
          location: null,
        },
        {
          id: "invalid-accuracy",
          employeeId: "employee-record-1",
          timestamp: new Date("2026-10-05T13:00:00.000Z"),
          punchType: "IN",
          workMode: "OFFICE",
          location: { latitude: 6.9, longitude: 79.8, accuracy: -1 },
        },
        {
          id: "invalid-coordinate",
          employeeId: "employee-record-1",
          timestamp: new Date("2026-10-05T14:00:00.000Z"),
          punchType: "OUT",
          workMode: "OFFICE",
          location: { latitude: 91, longitude: 79.8, accuracy: 2 },
        },
      ],
    });
    const result = await listAttendanceLocations(
      { id: "admin", role: Role.ADMIN },
      { date: "2026-10-05" },
      stub.database,
    );

    assert.deepEqual(result.records.map(({ location }) => location), [
      { latitude: 6.9, longitude: 79.8, accuracy: null },
      { latitude: 6.9, longitude: 79.8, accuracy: null },
      null,
      { latitude: 6.9, longitude: 79.8, accuracy: null },
      null,
    ]);
    assert.equal(stub.getAuditAttempts(), 1);
  });

  it("audits an empty result exactly once and reports when the Admin/HR result is capped", async () => {
    const empty = makeDatabase({ punches: [] });
    const emptyResult = await listAttendanceLocations(
      { id: "hr", role: Role.HR_ADMINISTRATOR },
      { date: "2026-10-05" },
      empty.database,
    );
    assert.deepEqual(emptyResult, { records: [], limitReached: false });
    assert.equal(empty.getAuditAttempts(), 1);
    assert.equal((empty.auditEvents[0] as { data: { newValues: { resultCount: number } } }).data.newValues.resultCount, 0);

    const exactlyLimited = makeDatabase({
      punches: Array.from({ length: 1000 }, (_, index) => ({
        id: `punch-${index}`,
        employeeId: "employee-record-1",
        timestamp: new Date(Date.UTC(2026, 9, 5, 0, index)),
        punchType: index % 2 === 0 ? "IN" : "OUT",
        workMode: "OFFICE",
        location: null,
      })),
    });
    const exactlyLimitedResult = await listAttendanceLocations(
      { id: "admin", role: Role.ADMIN },
      { date: "2026-10-05" },
      exactlyLimited.database,
    );
    assert.equal(exactlyLimitedResult.records.length, 1000);
    assert.equal(exactlyLimitedResult.limitReached, false);
    assert.equal((exactlyLimited.calls.punches as { take: number }).take, 1001);

    const capped = makeDatabase({
      punches: Array.from({ length: 1001 }, (_, index) => ({
        id: `punch-${index}`,
        employeeId: "employee-record-1",
        timestamp: new Date(Date.UTC(2026, 9, 5, 0, index)),
        punchType: index % 2 === 0 ? "IN" : "OUT",
        workMode: "OFFICE",
        location: null,
      })),
    });
    const cappedResult = await listAttendanceLocations(
      { id: "admin", role: Role.ADMIN },
      { date: "2026-10-05" },
      capped.database,
    );
    assert.equal(cappedResult.records.length, 1000);
    assert.equal(cappedResult.limitReached, true);
    assert.equal((capped.auditEvents[0] as { data: { newValues: { resultCount: number } } }).data.newValues.resultCount, 1000);
  });

  it("formats all four punch labels and flags poor accuracy without changing its value", () => {
    assert.deepEqual([
      attendanceLocationPunchLabel("IN", "OFFICE"),
      attendanceLocationPunchLabel("OUT", "OFFICE"),
      attendanceLocationPunchLabel("IN", "WFH"),
      attendanceLocationPunchLabel("OUT", "WFH"),
      attendanceLocationPunchLabel("IN", null),
    ], ["IN", "OUT", "WFH-IN", "WFH-OUT", "IN"]);
    assert.equal(hasPoorGpsAccuracy(12.5), false);
    assert.equal(hasPoorGpsAccuracy(POOR_GPS_ACCURACY_THRESHOLD_METERS), false);
    const poorAccuracy = 3798.125;
    assert.equal(hasPoorGpsAccuracy(poorAccuracy), true);
    assert.equal(poorAccuracy, 3798.125);
  });

  it("returns ordinary and poor browser-reported accuracy values unchanged", async () => {
    const poorAccuracy = 3798.125;
    const stub = makeDatabase({
      punches: [
        {
          id: "ordinary-accuracy",
          employeeId: "employee-record-1",
          timestamp: new Date("2026-10-05T02:30:00.000Z"),
          punchType: "IN",
          workMode: "OFFICE",
          location: storedLocation,
        },
        {
          id: "poor-accuracy",
          employeeId: "employee-record-1",
          timestamp: new Date("2026-10-05T11:30:00.000Z"),
          punchType: "OUT",
          workMode: "WFH",
          location: { ...storedLocation, accuracy: poorAccuracy },
        },
      ],
    });
    const records = await listAttendanceLocations(
      { id: "admin", role: Role.ADMIN },
      { date: "2026-10-05" },
      stub.database,
    );

    assert.deepEqual(records.records.map(({ location }) => location?.accuracy), [12.5, poorAccuracy]);
    assert.equal(hasPoorGpsAccuracy(records.records[0].location!.accuracy!), false);
    assert.equal(hasPoorGpsAccuracy(records.records[1].location!.accuracy!), true);
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
