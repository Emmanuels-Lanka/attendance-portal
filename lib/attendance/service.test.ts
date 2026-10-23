import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyAttendanceAction as applyAttendanceActionWithLocation, AttendanceStateError } from "./service";
import { attendanceActionSchema, attendanceLocationSchema, type AttendanceAction, type AttendanceLocation } from "./validation";
import { getEmployeeLocalDayWindow } from "./timezone";

type StoredSession = {
  id: string;
  employeeId: string;
  mode: "OFFICE" | "WFH";
  startAt: Date;
  endAt: Date | null;
};

const testLocation: AttendanceLocation = { latitude: 6.9271, longitude: 79.8612, accuracy: 12.5 };

function applyAttendanceAction(
  employeeId: string,
  action: AttendanceAction,
  database: never = undefined as never,
  now?: Date,
) {
  return applyAttendanceActionWithLocation(employeeId, action, testLocation, database, now);
}

function createDatabase(
  initialSessions: StoredSession[] = [],
  timeZone = "Asia/Colombo",
  hasEmployeeRecord = true,
  failReconciliationEnqueue = false,
) {
  const sessions = [...initialSessions];
  const rawPunches: Array<{
    id: string;
    employeeId: string;
    timestamp: Date;
    punchType: "IN" | "OUT";
    workMode: "OFFICE" | "WFH";
    source: string;
    deviceId: null;
    location: AttendanceLocation;
  }> = [];
  const reconciliationTasks = new Map<string, {
    id: string;
    employeeId: string;
    attendanceDate: Date;
    timeZone: string;
    lastPunchId: string;
    requestedVersion: number;
  }>();
  const reconciliationEvents = new Set<string>();
  type DatabaseSnapshot = {
    sessions: StoredSession[];
    punches: typeof rawPunches;
    tasks: typeof reconciliationTasks;
    events: Set<string>;
  };
  let nextId = 1;
  let nextRawId = 1;
  let lockTail: Promise<void> = Promise.resolve();
  const snapshotState: { value: DatabaseSnapshot | null } = { value: null };

  const database = {
    $transaction: async (operation: (transaction: never) => Promise<unknown>) => {
      let releaseLock = () => {};
      let mutationCount = 0;
      const transaction = {
        $queryRaw: async () => {
          const previousLock = lockTail;
          lockTail = new Promise<void>((resolve) => { releaseLock = resolve; });
          await previousLock;
          snapshotState.value = {
            sessions: structuredClone(sessions),
            punches: structuredClone(rawPunches),
            tasks: new Map(reconciliationTasks),
            events: new Set(reconciliationEvents),
          };
          return [];
        },
        workSession: {
          findFirst: async ({ where }: { where: { record: { employeeId: string }; endAt?: null; startAt?: { gte: Date; lt: Date }; OR?: Array<{ startAt?: { gte: Date; lt: Date }; endAt?: { gte: Date; lt: Date } }> } }) => {
            const matches = sessions.filter((session) => session.employeeId === where.record.employeeId);
            if (where.endAt === null) return matches.find((session) => session.endAt === null) ?? null;
            if (where.OR) return matches.find((session) => where.OR!.some((condition) => {
              if (condition.startAt) return session.startAt >= condition.startAt.gte && session.startAt < condition.startAt.lt;
              return session.endAt !== null && session.endAt >= condition.endAt!.gte && session.endAt < condition.endAt!.lt;
            })) ?? null;
            if (where.startAt) return matches.find((session) => session.startAt >= where.startAt!.gte && session.startAt < where.startAt!.lt) ?? null;
            return null;
          },
          update: async ({ where, data }: { where: { id: string }; data: { endAt: Date } }) => {
            const session = sessions.find((item) => item.id === where.id);
            if (!session) throw new Error("Missing session.");
            session.endAt = data.endAt;
            mutationCount += 1;
            return session;
          },
        },
        attendanceRecord: {
          create: async ({ data }: { data: { employeeId: string; sessions: { create: { mode: "OFFICE" | "WFH"; startAt: Date } } } }) => {
            const session = {
              id: `session-${nextId++}`,
              employeeId: data.employeeId,
              mode: data.sessions.create.mode,
              startAt: data.sessions.create.startAt,
              endAt: null,
            };
            sessions.push(session);
            mutationCount += 1;
            return { sessions: [session] };
          },
        },
        attendanceRaw: {
          create: async ({ data }: { data: Omit<(typeof rawPunches)[number], "id"> & { location: unknown } }) => {
            const punch = {
              id: `raw-${nextRawId++}`,
              ...data,
              location: attendanceLocationSchema.parse(data.location),
            };
            rawPunches.push(punch);
            mutationCount += 1;
            return punch;
          },
        },
        attendanceDailyCalculationTask: {
          findUnique: async ({ where }: { where: { employeeId_attendanceDate: { employeeId: string; attendanceDate: Date } } }) =>
            reconciliationTasks.get(`${where.employeeId_attendanceDate.employeeId}:${where.employeeId_attendanceDate.attendanceDate.toISOString()}`) ?? null,
          create: async ({ data }: {
            data: { employeeId: string; attendanceDate: Date; timeZone: string; lastPunchId: string };
          }) => {
            if (failReconciliationEnqueue) throw new Error("Outbox unavailable.");
            const key = `${data.employeeId}:${data.attendanceDate.toISOString()}`;
            const task = { ...data, id: `task-${reconciliationTasks.size + 1}`, requestedVersion: 1 };
            reconciliationTasks.set(key, task);
            mutationCount += 1;
            return task;
          },
          update: async ({ where, data }: {
            where: { id: string };
            data: { requestedVersion: { increment: number }; timeZone: string; lastPunchId: string };
          }) => {
            const entry = [...reconciliationTasks.entries()].find(([, task]) => task.id === where.id);
            if (!entry) throw new Error("Task is missing.");
            const [key, current] = entry;
            const task = {
              ...current,
              requestedVersion: current.requestedVersion + data.requestedVersion.increment,
              timeZone: data.timeZone,
              lastPunchId: data.lastPunchId,
            };
            reconciliationTasks.set(key, task);
            mutationCount += 1;
            return task;
          },
        },
        attendanceDailyCalculationTaskEvent: {
          createMany: async ({ data }: { data: Array<{ taskId: string; punchId: string }> }) => {
            if (failReconciliationEnqueue) throw new Error("Outbox unavailable.");
            let count = 0;
            for (const event of data) {
              const key = `${event.taskId}:${event.punchId}`;
              if (!reconciliationEvents.has(key)) {
                reconciliationEvents.add(key);
                count += 1;
              }
            }
            mutationCount += count;
            return { count };
          },
        },
        employee: {
          findUnique: async () => hasEmployeeRecord ? { id: "employee-record-1" } : null,
        },
        user: {
          findUnique: async () => ({ timeZone }),
        },
      };

      try {
        return await operation(transaction as never);
      } catch (error) {
        const snapshots = snapshotState.value;
        if (snapshots && mutationCount > 0) {
          sessions.splice(0, sessions.length, ...snapshots.sessions);
          rawPunches.splice(0, rawPunches.length, ...snapshots.punches);
          reconciliationTasks.clear();
          for (const [key, value] of snapshots.tasks) reconciliationTasks.set(key, value);
          reconciliationEvents.clear();
          for (const event of snapshots.events) reconciliationEvents.add(event);
        }
        throw error;
      } finally {
        releaseLock();
      }
    },
  };

  return { database: database as never, sessions, rawPunches, reconciliationTasks };
}

function activeSession(id: string): StoredSession {
  return { id, employeeId: "employee-1", mode: "OFFICE", startAt: new Date("2026-06-15T02:30:00.000Z"), endAt: null };
}

describe("employee attendance transitions", () => {
  it("serializes concurrent IN actions so only one open session is created", async () => {
    const stub = createDatabase();
    const results = await Promise.allSettled([
      applyAttendanceAction("employee-1", "IN", stub.database),
      applyAttendanceAction("employee-1", "IN", stub.database),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(rejection?.reason instanceof AttendanceStateError);
    assert.equal(stub.sessions.length, 1);
    assert.equal(stub.sessions.filter(({ endAt }) => endAt === null).length, 1);
    assert.equal(stub.rawPunches.length, 1);
    assert.equal(stub.rawPunches[0].punchType, "IN");
    assert.equal(stub.reconciliationTasks.size, 1);
    assert.equal([...stub.reconciliationTasks.values()][0].requestedVersion, 1);
  });

  it("serializes concurrent OUT actions so only one request closes the session", async () => {
    const stub = createDatabase([activeSession("open")]);
    const results = await Promise.allSettled([
      applyAttendanceAction("employee-1", "OUT", stub.database),
      applyAttendanceAction("employee-1", "OUT", stub.database),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(rejection?.reason instanceof AttendanceStateError);
    assert.equal(stub.sessions.filter(({ endAt }) => endAt === null).length, 0);
    assert.equal(stub.rawPunches.length, 1);
    assert.equal(stub.rawPunches[0].punchType, "OUT");
    assert.equal(stub.reconciliationTasks.size, 2);
  });

  it("persists accepted IN and OUT evidence with the exact session timestamps and capture metadata", async () => {
    const stub = createDatabase();
    const startedAt = new Date("2026-06-15T02:30:17.123Z");
    const endedAt = new Date("2026-06-15T11:30:42.456Z");
    const inLocation = { latitude: 6.9271, longitude: 79.8612, accuracy: 8 };
    const outLocation = { latitude: 6.9272, longitude: 79.8613, accuracy: 17 };

    const started = await applyAttendanceActionWithLocation("user-1", "IN", inLocation, stub.database, startedAt);
    const acceptedInPunch = structuredClone(stub.rawPunches[0]);
    const ended = await applyAttendanceActionWithLocation("user-1", "OUT", outLocation, stub.database, endedAt);

    assert.equal(started.startAt.toISOString(), startedAt.toISOString());
    assert.equal(ended.endAt?.toISOString(), endedAt.toISOString());
    assert.deepEqual(stub.rawPunches[0], acceptedInPunch);
    assert.deepEqual(stub.rawPunches.map(({ employeeId, timestamp, punchType, workMode, source, deviceId, location }) => ({
      employeeId,
      timestamp: timestamp.toISOString(),
      punchType,
      workMode,
      source,
      deviceId,
      location,
    })), [
      {
        employeeId: "employee-record-1",
        timestamp: startedAt.toISOString(),
        punchType: "IN",
        workMode: "OFFICE",
        source: "WEB",
        deviceId: null,
        location: inLocation,
      },
      {
        employeeId: "employee-record-1",
        timestamp: endedAt.toISOString(),
        punchType: "OUT",
        workMode: "OFFICE",
        source: "WEB",
        deviceId: null,
        location: outLocation,
      },
    ]);
    assert.equal(stub.sessions.length, 1);
    assert.equal(stub.sessions[0].startAt.toISOString(), stub.rawPunches[0].timestamp.toISOString());
    assert.equal(stub.sessions[0].endAt?.toISOString(), stub.rawPunches[1].timestamp.toISOString());
    assert.equal(stub.reconciliationTasks.size, 1);
    assert.equal([...stub.reconciliationTasks.values()][0].requestedVersion, 2);
  });

  it("rolls back the punch when durable outbox insertion fails in the punch transaction", async () => {
    const stub = createDatabase([], "Asia/Colombo", true, true);

    await assert.rejects(applyAttendanceAction("employee-1", "IN", stub.database), /Outbox unavailable/);

    assert.equal(stub.sessions.length, 0);
    assert.equal(stub.rawPunches.length, 0);
    assert.equal(stub.reconciliationTasks.size, 0);
  });

  it("persists WFH_IN and WFH_OUT as directional punches with separate WFH mode", async () => {
    const startStub = createDatabase();
    await applyAttendanceAction("employee-1", "WFH_IN", startStub.database);
    assert.equal(startStub.rawPunches[0].punchType, "IN");
    assert.equal(startStub.rawPunches[0].workMode, "WFH");

    const endStub = createDatabase([{ ...activeSession("wfh-open"), mode: "WFH" }]);
    await applyAttendanceAction("employee-1", "WFH_OUT", endStub.database);
    assert.equal(endStub.rawPunches[0].punchType, "OUT");
    assert.equal(endStub.rawPunches[0].workMode, "WFH");
  });

  it("records an HR Administrator's own attendance using the linked Employee record", async () => {
    const stub = createDatabase();

    const started = await applyAttendanceAction("hr-session-user", "IN", stub.database);

    assert.equal(stub.sessions[0].employeeId, "hr-session-user");
    assert.equal(started.id, stub.sessions[0].id);
    assert.equal(stub.rawPunches[0].employeeId, "employee-record-1");
    assert.equal(stub.rawPunches[0].punchType, "IN");
    assert.equal(stub.reconciliationTasks.size, 1);
  });

  it("does not create raw evidence for rejected actions or users without a linked Employee", async () => {
    const noEmployee = createDatabase([], "Asia/Colombo", false);
    await assert.rejects(
      applyAttendanceAction("user-without-employee", "IN", noEmployee.database),
      /Employee record is required/,
    );
    assert.equal(noEmployee.sessions.length, 0);
    assert.equal(noEmployee.rawPunches.length, 0);

    const duplicateStart = createDatabase([activeSession("already-open")]);
    await assert.rejects(applyAttendanceAction("employee-1", "IN", duplicateStart.database), AttendanceStateError);
    await assert.rejects(applyAttendanceAction("employee-1", "WFH_OUT", duplicateStart.database), /different work mode/);
    assert.deepEqual(duplicateStart.rawPunches, []);
  });

  it("rejects missing or invalid coordinates before opening a database transaction", async () => {
    const stub = createDatabase();
    for (const location of [
      undefined,
      { latitude: 91, longitude: 10, accuracy: 1 },
      { latitude: 10, longitude: -181, accuracy: 1 },
      { latitude: 10, longitude: 10, accuracy: -1 },
      { latitude: Number.NaN, longitude: 10, accuracy: 1 },
    ]) {
      await assert.rejects(
        applyAttendanceActionWithLocation("employee-1", "IN", location, stub.database),
        AttendanceStateError,
      );
    }
    assert.equal(stub.sessions.length, 0);
    assert.equal(stub.rawPunches.length, 0);
  });

  it("rejects invalid server timestamps before writing either IN or OUT", async () => {
    const invalidTimestamp = new Date(Number.NaN);
    const startStub = createDatabase();
    const endStub = createDatabase([activeSession("open")]);

    await assert.rejects(
      applyAttendanceActionWithLocation("employee-1", "IN", testLocation, startStub.database, invalidTimestamp),
      /valid server timestamp/,
    );
    await assert.rejects(
      applyAttendanceActionWithLocation("employee-1", "OUT", testLocation, endStub.database, invalidTimestamp),
      /valid server timestamp/,
    );
    assert.equal(startStub.sessions.length, 0);
    assert.equal(startStub.rawPunches.length, 0);
    assert.equal(endStub.sessions[0].endAt, null);
    assert.equal(endStub.rawPunches.length, 0);
  });

  it("serializes competing same-day starts after a completed session", async () => {
    const now = new Date("2026-06-15T04:00:00.000Z");
    const completed = { ...activeSession("completed"), endAt: new Date("2026-06-15T05:00:00.000Z") };
    const stub = createDatabase([completed]);
    const results = await Promise.allSettled([
      applyAttendanceAction("employee-1", "IN", stub.database, now),
      applyAttendanceAction("employee-1", "WFH_IN", stub.database, now),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 0);
    assert.equal(stub.sessions.length, 1);
    assert.ok(results.every((result) => result.status === "rejected" && result.reason instanceof AttendanceStateError));
  });

  it("rejects OUT without an open session and rejects mismatched modes", async () => {
    const empty = createDatabase();
    await assert.rejects(applyAttendanceAction("employee-1", "OUT", empty.database), AttendanceStateError);

    const open = createDatabase([activeSession("open")]);
    await assert.rejects(applyAttendanceAction("employee-1", "WFH_OUT", open.database), /different work mode/);
    assert.equal(open.sessions[0].endAt, null);
  });

  it("rejects an OUT timestamp earlier than the stored IN", async () => {
    const futureStart = activeSession("future-start");
    futureStart.startAt = new Date(Date.now() + 60 * 60 * 1000);
    const stub = createDatabase([futureStart]);

    await assert.rejects(applyAttendanceAction("employee-1", "OUT", stub.database), /cannot end before it started/);
    assert.equal(stub.sessions[0].endAt, null);
  });

  it("blocks same-day mixed-mode restarts after a completed session", async () => {
    const stub = createDatabase();
    const now = new Date("2026-06-15T02:30:00.000Z");
    await applyAttendanceAction("employee-1", "IN", stub.database, now);
    await applyAttendanceAction("employee-1", "OUT", stub.database, new Date("2026-06-15T03:30:00.000Z"));
    await assert.rejects(
      applyAttendanceAction("employee-1", "WFH_IN", stub.database, new Date("2026-06-15T04:00:00.000Z")),
      /already completed attendance for your local day/,
    );

    const nextDay = getEmployeeLocalDayWindow(new Date("2026-06-15T18:30:00.000Z"), "Asia/Colombo");
    await applyAttendanceAction("employee-1", "WFH_IN", stub.database, nextDay.startAt);
    assert.deepEqual(stub.sessions.map(({ mode }) => mode), ["OFFICE", "WFH"]);
  });

  it("uses Sri Lanka and Bangladesh local-day boundaries", async () => {
    const yesterdaySession = {
      id: "completed-yesterday",
      employeeId: "employee-1",
      mode: "OFFICE" as const,
      startAt: new Date("2026-06-15T17:45:00.000Z"),
      endAt: new Date("2026-06-15T17:50:00.000Z"),
    };
    const boundaryUtc = new Date("2026-06-15T18:20:00.000Z");
    const sriLanka = createDatabase([yesterdaySession], "Asia/Colombo");
    await assert.rejects(
      applyAttendanceAction("employee-1", "WFH_IN", sriLanka.database, boundaryUtc),
      /already completed attendance for your local day/,
    );

    const bangladesh = createDatabase([yesterdaySession], "Asia/Dhaka");
    await applyAttendanceAction("employee-1", "IN", bangladesh.database, boundaryUtc);

    assert.equal(getEmployeeLocalDayWindow(boundaryUtc, "Asia/Colombo").date, "2026-06-15");
    assert.equal(getEmployeeLocalDayWindow(boundaryUtc, "Asia/Dhaka").date, "2026-06-16");
  });

  it("blocks a new local-day start after an overnight session ends today", async () => {
    const overnight = {
      id: "overnight",
      employeeId: "employee-1",
      mode: "OFFICE" as const,
      startAt: new Date("2026-06-15T17:45:00.000Z"),
      endAt: new Date("2026-06-15T18:15:00.000Z"),
    };
    const stub = createDatabase([overnight], "Asia/Colombo");

    await assert.rejects(
      applyAttendanceAction("employee-1", "WFH_IN", stub.database, new Date("2026-06-15T18:20:00.000Z")),
      /already completed attendance for your local day/,
    );
  });

  it("uses the supplied timestamp when closing a session", async () => {
    const stub = createDatabase([activeSession("open")]);
    const endedAt = new Date("2026-06-15T04:00:00.000Z");

    await applyAttendanceAction("employee-1", "OUT", stub.database, endedAt);

    assert.equal(stub.sessions[0].endAt?.toISOString(), endedAt.toISOString());
  });

  it("validates action payloads and requires valid GPS coordinates", () => {
    assert.equal(attendanceActionSchema.safeParse({ action: "BREAK", location: testLocation }).success, false);
    assert.equal(attendanceActionSchema.safeParse({ action: "IN" }).success, false);
    assert.equal(attendanceActionSchema.safeParse({ action: "WFH_OUT", location: testLocation }).success, true);
    assert.deepEqual(
      attendanceActionSchema.parse({
        action: "IN",
        location: testLocation,
        userId: "another-user",
        employeeId: "another-employee",
      }),
      { action: "IN", location: testLocation },
    );
    assert.equal(attendanceLocationSchema.safeParse({ latitude: 91, longitude: 0, accuracy: 0 }).success, false);
    assert.equal(attendanceLocationSchema.safeParse({ latitude: 0, longitude: 181, accuracy: 0 }).success, false);
    assert.equal(attendanceLocationSchema.safeParse({ latitude: 0, longitude: 0, accuracy: -0.1 }).success, false);
    assert.equal(attendanceLocationSchema.safeParse({ latitude: 0, longitude: 0 }).success, false);
    assert.equal(attendanceLocationSchema.safeParse({ latitude: 0, longitude: 0, accuracy: "10" }).success, false);
    assert.equal(attendanceLocationSchema.safeParse({ latitude: 0, longitude: 0, accuracy: Number.NaN }).success, false);
  });
});