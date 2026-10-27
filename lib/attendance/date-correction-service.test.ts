import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AttendanceCorrectionApprovalStage, AttendanceCorrectionStatus, Role } from "@prisma/client";
import {
  DailyAttendanceCorrectionAccessError,
  DailyAttendanceCorrectionInvalidValuesError,
  DailyAttendanceCorrectionPendingRequestExistsError,
  DailyAttendanceCorrectionConflictError,
  DailyAttendanceCorrectionSelfApprovalError,
  DailyAttendanceCorrectionStageError,
  decideDailyAttendanceCorrection,
  listOwnAttendanceCorrectionHistory,
  submitAttendanceDateCorrection,
} from "./correction-service";

const attendanceDate = "2026-10-05";
const employeeActor = { id: "employee-user", role: Role.EMPLOYEE };
const hrActor = { id: "hr-user", role: Role.HR_ADMINISTRATOR };
const supervisorActor = { id: "supervisor-user", role: Role.SUPERVISOR };
const independentHrActor = { id: "independent-hr", role: Role.HR_ADMINISTRATOR };
type SessionState = {
  id: string;
  recordId: string;
  mode: "OFFICE" | "WFH";
  startAt: Date;
  endAt: Date | null;
};
type DailyState = {
  id: string;
  employeeId: string;
  date: Date;
  firstIn: Date | null;
  lastOut: Date | null;
  status: string | null;
  [key: string]: unknown;
};

function createHarness(options: {
  ownerId?: string;
  ownerRole?: Role;
  employeeLinked?: boolean;
  session?: {
    id: string;
    recordId: string;
    mode: "OFFICE" | "WFH";
    startAt: Date;
    endAt: Date | null;
  } | null;
  daily?: {
    id: string;
    firstIn: Date | null;
    lastOut: Date | null;
    status: string | null;
  } | null;
  rawPunches?: Array<{
    timestamp: Date;
    punchType: "IN" | "OUT";
    workMode: "OFFICE" | "WFH";
  }>;
  emptyRecordId?: string;
  failDailyUpdate?: boolean;
} = {}) {
  const ownerId = options.ownerId ?? employeeActor.id;
  const ownerRole = options.ownerRole ?? Role.EMPLOYEE;
  const employeeLinked = options.employeeLinked ?? true;
  let session: SessionState | null = options.session ? structuredClone(options.session) : null;
  let daily: DailyState | null = options.daily
    ? {
        ...structuredClone(options.daily),
        employeeId: "employee-record",
        date: new Date(`${attendanceDate}T00:00:00.000Z`),
      }
    : null;
  const raw: Array<{ id: string; timestamp: Date; punchType: "IN" | "OUT"; workMode: "OFFICE" | "WFH" }> =
    options.rawPunches
      ? options.rawPunches.map((punch, index) => ({ id: `raw-${index + 1}`, ...punch }))
      : [
          ...(daily?.firstIn ? [{
            id: "raw-in",
            timestamp: daily.firstIn,
            punchType: "IN" as const,
            workMode: session?.mode ?? "OFFICE",
          }] : []),
          ...(daily?.lastOut ? [{
            id: "raw-out",
            timestamp: daily.lastOut,
            punchType: "OUT" as const,
            workMode: session?.mode ?? "OFFICE",
          }] : []),
        ];
  const requests: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];
  const records: Array<{ id: string; sessions: Array<{ id: string }> }> = options.emptyRecordId
    ? [{ id: options.emptyRecordId, sessions: [] }]
    : [];
  let nextId = 1;

  const transaction = {
    $queryRaw: async () => [],
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (where.id === ownerId) return { id: ownerId, role: ownerRole, isActive: true, timeZone: "Asia/Colombo" };
        if (where.id === "supervisor-user") return { id: where.id, role: Role.SUPERVISOR, isActive: true, timeZone: "Asia/Colombo" };
        if (where.id === "hr-user" || where.id === "independent-hr") {
          return { id: where.id, role: Role.HR_ADMINISTRATOR, isActive: true, timeZone: "Asia/Colombo" };
        }
        return null;
      },
      findMany: async ({ where }: { where: { role: Role; id?: { not: string }; isActive: boolean } }) => {
        const candidates = ["hr-user", "independent-hr"];
        return candidates
          .filter((id) => id !== where.id?.not)
          .map((id) => ({ id }));
      },
    },
    employee: {
      findUnique: async ({ where }: { where: { id?: string; userId?: string } }) => {
        if (where.userId) {
          return employeeLinked && where.userId === ownerId
            ? {
                id: "employee-record",
                supervisor: {
                  userId: "supervisor-user",
                  user: { role: Role.SUPERVISOR, isActive: true },
                },
              }
            : null;
        }
        if (where.id === "employee-record") {
          return {
            id: "employee-record",
            user: { timeZone: "Asia/Colombo", countryCode: "LK" },
            shift: {
              id: "shift",
              startTime: new Date("1970-01-01T08:00:00.000Z"),
              endTime: new Date("1970-01-01T17:00:00.000Z"),
              gracePeriodMinutes: 10,
              lateThresholdMinutes: 0,
              earlyDepartureThresholdMinutes: 0,
              breakDurationMinutes: 0,
              minimumWorkingHours: "8",
              overtimeEligible: false,
              roundingRules: null,
              workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
            },
            shiftAssignments: [],
          };
        }
        return null;
      },
    },
    attendanceDaily: {
      findFirst: async () => daily,
      findMany: async ({ select }: { select?: { firstIn?: boolean; date?: boolean } }) => {
        if (!daily) return [];
        if (select?.date && !select.firstIn) return [{ date: daily.date }];
        return select?.firstIn ? [daily] : [{ id: daily.id }];
      },
      findUnique: async ({ where }: { where: { id: string } }) => daily?.id === where.id ? daily : null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        daily = { id: "daily-created", employeeId: "employee-record", ...data } as DailyState;
        return { id: daily.id };
      },
      updateMany: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (options.failDailyUpdate || !daily || daily.id !== where.id) return { count: 0 };
        daily = { ...daily, ...data };
        return { count: 1 };
      },
    },
    attendanceRaw: {
      findMany: async () => raw,
      create: async () => { throw new Error("Correction must not create raw punches."); },
    },
    workSession: {
      findMany: async () => session ? [{ ...session }] : [],
      findUnique: async ({ where }: { where: { id: string } }) => session?.id === where.id
        ? {
            ...session,
            record: {
              employeeId: ownerId,
              employee: { employee: { supervisor: { userId: "supervisor-user" } } },
            },
          }
        : null,
      updateMany: async ({ where, data }: {
        where: { id: string; recordId: string; mode: "OFFICE" | "WFH"; startAt: Date; endAt: Date | null };
        data: { startAt: Date; endAt: Date | null; mode: "OFFICE" | "WFH" };
      }) => {
        if (
          !session
          || session.id !== where.id
          || session.mode !== where.mode
          || session.startAt.getTime() !== where.startAt.getTime()
          || session.endAt?.getTime() !== where.endAt?.getTime()
        ) return { count: 0 };
        session = { ...session, ...data };
        return { count: 1 };
      },
      create: async ({ data }: {
        data: { recordId: string; mode: "OFFICE" | "WFH"; startAt: Date; endAt: Date | null };
      }) => {
        session = { id: "session-created", ...data };
        records.find((record) => record.id === data.recordId)?.sessions.push({ id: session.id });
        return { id: session.id };
      },
    },
    attendanceRecord: {
      findMany: async () => records.map((record) => structuredClone(record)),
      create: async ({ data }: {
        data: { employeeId: string; workDate: Date; sessions: { create: { mode: "OFFICE" | "WFH"; startAt: Date; endAt: Date | null } } };
      }) => {
        const recordId = `record-created-${records.length + 1}`;
        session = { id: "session-created", recordId, ...data.sessions.create };
        records.push({ id: recordId, sessions: [{ id: session.id }] });
        return { sessions: [{ id: session.id }] };
      },
    },
    attendanceCorrectionRequest: {
      findFirst: async ({ where }: { where: { employeeId: string; status: AttendanceCorrectionStatus; OR?: Array<Record<string, unknown>> } }) => {
        const pending = requests.find((request) =>
          request.employeeId === where.employeeId
          && request.status === where.status
          && where.OR?.some((condition) =>
            ("attendanceDate" in condition && (request.attendanceDate as Date)?.getTime() === (condition.attendanceDate as Date)?.getTime())
            || ("sessionId" in condition && request.sessionId === condition.sessionId)
            || ("dailyAttendanceId" in condition && request.dailyAttendanceId === condition.dailyAttendanceId),
          ));
        return pending ? { id: pending.id } : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const request = { id: `correction-${nextId++}`, ...data };
        requests.push(request);
        return request;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const request = requests.find((candidate) => candidate.id === where.id);
        if (!request) return null;
        const currentSession = session && session.id === request.sessionId ? {
          ...session,
          record: {
            employeeId: ownerId,
            employee: { employee: { supervisor: { userId: "supervisor-user" } } },
          },
        } : null;
        return {
          ...request,
          dailyAttendance: daily && daily.id === request.dailyAttendanceId
            ? {
                id: daily.id,
                employeeId: "employee-record",
                date: new Date(`${attendanceDate}T00:00:00.000Z`),
                firstIn: daily.firstIn,
                lastOut: daily.lastOut,
                employee: {
                  id: "employee-record",
                  userId: ownerId,
                  supervisor: { userId: "supervisor-user" },
                },
              }
            : null,
          session: currentSession,
          employee: {
            employee: {
              id: "employee-record",
              supervisor: { userId: "supervisor-user" },
            },
          },
          auditLogs: [],
        };
      },
      updateMany: async ({ where, data }: {
        where: { id: string; status: AttendanceCorrectionStatus; currentApprovalStage?: AttendanceCorrectionApprovalStage; dailyAttendanceId?: string | null };
        data: Record<string, unknown>;
      }) => {
        const request = requests.find((candidate) => candidate.id === where.id);
        if (!request || request.status !== where.status) return { count: 0 };
        if (where.currentApprovalStage && request.currentApprovalStage !== where.currentApprovalStage) return { count: 0 };
        Object.assign(request, data);
        return { count: 1 };
      },
      findMany: async ({ where }: { where: { employeeId: string } }) => requests
        .filter((request) => request.employeeId === where.employeeId)
        .map((request) => ({
          ...request,
          reviewedBy: null,
          dailyAttendance: daily && daily.id === request.dailyAttendanceId ? { date: new Date(`${attendanceDate}T00:00:00.000Z`) } : null,
          session: session && session.id === request.sessionId ? { startAt: session.startAt } : null,
        })),
    },
    attendanceAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return { id: `audit-${audits.length}` };
      },
    },
    notification: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        notifications.push(data);
        return { id: `notification-${notifications.length}` };
      },
    },
  };

  const database = {
    $transaction: async <T>(callback: (tx: typeof transaction) => Promise<T>) => {
      const before = structuredClone({ session, daily, records, requests, audits, notifications });
      try {
        return await callback(transaction);
      } catch (error) {
        session = before.session;
        daily = before.daily;
        records.splice(0, records.length, ...before.records);
        requests.splice(0, requests.length, ...before.requests);
        audits.splice(0, audits.length, ...before.audits);
        notifications.splice(0, notifications.length, ...before.notifications);
        throw error;
      }
    },
    attendanceCorrectionRequest: transaction.attendanceCorrectionRequest,
  } as unknown as Parameters<typeof submitAttendanceDateCorrection>[2];
  return {
    database,
    historyDatabase: {
      attendanceCorrectionRequest: transaction.attendanceCorrectionRequest,
    } as unknown as Parameters<typeof listOwnAttendanceCorrectionHistory>[1],
    requests,
    audits,
    notifications,
    records,
    raw,
    correctionRequests: requests,
    get session(): SessionState | null { return session; },
    get daily(): DailyState | null { return daily; },
    getSession: () => session,
    getDaily: () => daily,
    materializeDaily: (firstIn: Date | null, lastOut: Date | null) => {
      daily = {
        id: "daily-materialized",
        employeeId: "employee-record",
        date: new Date(`${attendanceDate}T00:00:00.000Z`),
        firstIn,
        lastOut,
        status: "MISSING_PUNCH",
      };
    },
  };
}

async function submit(
  harness: ReturnType<typeof createHarness>,
  actor: { id: string; role: Role } = employeeActor,
  input: {
    firstIn?: string;
    lastOut?: string;
    mode?: "OFFICE" | "WFH";
  } = {},
) {
  return submitAttendanceDateCorrection(actor, {
    attendanceDate,
    requestedValues: {
      ...(input.firstIn ? { firstIn: input.firstIn } : {}),
      ...(input.lastOut ? { lastOut: input.lastOut } : {}),
    },
    requestedMode: input.mode ?? "OFFICE",
    reason: "Correct missed or inaccurate attendance punches",
  }, harness.database);
}

describe("date-based attendance correction requests", () => {
  it("accepts HR self-requests without a daily row or session, then creates a WFH session and daily result after independent approvals", async () => {
    const harness = createHarness({ ownerId: hrActor.id, ownerRole: Role.HR_ADMINISTRATOR });
    const request = await submit(harness, hrActor, {
      firstIn: "2026-10-05T05:17:00.000Z",
      lastOut: "2026-10-05T12:46:00.000Z",
      mode: "WFH",
    });
    assert.equal(request.status, AttendanceCorrectionStatus.PENDING);
    assert.equal(request.currentApprovalStage, AttendanceCorrectionApprovalStage.SUPERVISOR);
    assert.equal(request.dailyAttendanceId, null);
    assert.equal(request.sessionId, null);
    assert.equal(harness.session, null);
    assert.equal(harness.daily, null);
    assert.deepEqual(harness.raw, []);

    await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
    assert.equal(harness.session, null);
    assert.equal(harness.daily, null);
    await assert.rejects(
      decideDailyAttendanceCorrection(hrActor, request.id, { action: "APPROVE" }, harness.database),
      DailyAttendanceCorrectionSelfApprovalError,
    );
    const result = await decideDailyAttendanceCorrection(
      independentHrActor,
      request.id,
      { action: "APPROVE" },
      harness.database,
    );

    assert.equal(result.status, AttendanceCorrectionStatus.APPROVED);
    assert.equal(harness.getSession()?.mode, "WFH");
    assert.equal(harness.getSession()?.startAt.toISOString(), "2026-10-05T05:17:00.000Z");
    assert.equal(harness.getSession()?.endAt?.toISOString(), "2026-10-05T12:46:00.000Z");
    assert.equal(harness.getDaily()?.firstIn?.toISOString(), "2026-10-05T05:17:00.000Z");
    assert.equal(harness.getDaily()?.lastOut?.toISOString(), "2026-10-05T12:46:00.000Z");
    assert.ok(harness.getDaily()?.status);
    assert.equal(harness.correctionRequests[0]?.dailyAttendanceId, "daily-created");
    assert.equal(harness.correctionRequests[0]?.sessionId, "session-created");
    assert.deepEqual(harness.raw, []);
    assert.equal(harness.audits.at(-1)?.actorId, independentHrActor.id);
    await assert.rejects(
      decideDailyAttendanceCorrection(
        independentHrActor,
        request.id,
        { action: "APPROVE" },
        harness.database,
      ),
      DailyAttendanceCorrectionStageError,
    );
  });

  it("preserves an existing OUT while correcting an existing OFFICE start time", async () => {
    const harness = createHarness({
      session: {
        id: "session-existing",
        recordId: "record-existing",
        mode: "OFFICE",
        startAt: new Date("2026-10-05T03:00:00.000Z"),
        endAt: new Date("2026-10-05T12:00:00.000Z"),
      },
      daily: {
        id: "daily-existing",
        firstIn: new Date("2026-10-05T03:00:00.000Z"),
        lastOut: new Date("2026-10-05T12:00:00.000Z"),
        status: "PRESENT",
      },
    });
    const originalEnd = harness.session?.endAt?.toISOString();
    const rawEvidenceBefore = structuredClone(harness.raw);
    const request = await submit(harness, employeeActor, {
      firstIn: "2026-10-05T03:21:00.000Z",
      mode: "OFFICE",
    });
    await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
    await decideDailyAttendanceCorrection(independentHrActor, request.id, { action: "APPROVE" }, harness.database);

    assert.equal(harness.getSession()?.startAt.toISOString(), "2026-10-05T03:21:00.000Z");
    assert.equal(harness.getSession()?.endAt?.toISOString(), originalEnd);
    assert.equal(harness.getDaily()?.firstIn?.toISOString(), "2026-10-05T03:21:00.000Z");
    assert.equal(harness.getDaily()?.lastOut?.toISOString(), originalEnd);
    assert.deepEqual(harness.raw, rawEvidenceBefore);
  });

  it("approves a first-IN correction for an existing open WFH session with no daily row or date-scoped record", async () => {
    const originalStart = new Date("2026-10-05T03:57:27.000Z");
    const correctedStart = new Date("2026-10-05T03:00:00.000Z");
    const harness = createHarness({
      session: {
        id: "session-open-wfh",
        recordId: "record-without-work-date",
        mode: "WFH",
        startAt: originalStart,
        endAt: null,
      },
    });
    const request = await submit(harness, employeeActor, {
      firstIn: correctedStart.toISOString(),
      mode: "WFH",
    });

    assert.equal(request.dailyAttendanceId, null);
    assert.equal(request.sessionId, "session-open-wfh");
    assert.deepEqual(request.originalValues, {
      attendanceDate,
      timeZone: "Asia/Colombo",
      attendanceRecordId: null,
      dailyAttendance: null,
      session: {
        id: "session-open-wfh",
        recordId: "record-without-work-date",
        mode: "WFH",
        startAt: originalStart.toISOString(),
        endAt: null,
      },
    });

    await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
    assert.equal(harness.correctionRequests[0]?.status, AttendanceCorrectionStatus.PENDING);
    assert.equal(harness.correctionRequests[0]?.currentApprovalStage, AttendanceCorrectionApprovalStage.HR);
    const result = await decideDailyAttendanceCorrection(
      independentHrActor,
      request.id,
      { action: "APPROVE" },
      harness.database,
    );

    assert.equal(result.status, AttendanceCorrectionStatus.APPROVED);
    assert.equal(harness.getSession()?.id, "session-open-wfh");
    assert.equal(harness.getSession()?.recordId, "record-without-work-date");
    assert.equal(harness.getSession()?.mode, "WFH");
    assert.equal(harness.getSession()?.startAt.toISOString(), correctedStart.toISOString());
    assert.equal(harness.getSession()?.endAt, null);
    assert.equal(harness.getDaily()?.firstIn?.toISOString(), correctedStart.toISOString());
  });

  it("allows a consistent daily row materialized from an unchanged open session between reviews", async () => {
    const originalStart = new Date("2026-10-05T03:00:00.000Z");
    const correctedStart = new Date("2026-10-05T03:20:00.000Z");
    const harness = createHarness({
      session: {
        id: "session-materialized-daily",
        recordId: "record-materialized-daily",
        mode: "OFFICE",
        startAt: originalStart,
        endAt: null,
      },
    });
    const request = await submit(harness, employeeActor, {
      firstIn: correctedStart.toISOString(),
    });
    await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
    harness.materializeDaily(originalStart, null);

    const result = await decideDailyAttendanceCorrection(
      independentHrActor,
      request.id,
      { action: "APPROVE" },
      harness.database,
    );

    assert.equal(result.status, AttendanceCorrectionStatus.APPROVED);
    assert.equal(harness.getDaily()?.id, "daily-materialized");
    assert.equal(harness.getDaily()?.firstIn?.toISOString(), correctedStart.toISOString());
    assert.equal(harness.getSession()?.startAt.toISOString(), correctedStart.toISOString());
  });

  it("preserves a legitimate OUT recorded after a first-IN-only request", async () => {
    const originalStart = new Date("2026-10-05T03:00:00.000Z");
    const requestedStart = new Date("2026-10-05T03:15:00.000Z");
    const actualOut = new Date("2026-10-05T12:30:00.000Z");
    const harness = createHarness({
      session: {
        id: "session-later-out",
        recordId: "record-later-out",
        mode: "WFH",
        startAt: originalStart,
        endAt: null,
      },
    });
    const request = await submit(harness, employeeActor, {
      firstIn: requestedStart.toISOString(),
      mode: "WFH",
    });
    await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
    harness.getSession()!.endAt = actualOut;
    harness.materializeDaily(originalStart, actualOut);

    const result = await decideDailyAttendanceCorrection(
      independentHrActor,
      request.id,
      { action: "APPROVE" },
      harness.database,
    );

    assert.equal(result.status, AttendanceCorrectionStatus.APPROVED);
    assert.equal(harness.getSession()?.startAt.toISOString(), requestedStart.toISOString());
    assert.equal(harness.getSession()?.endAt?.toISOString(), actualOut.toISOString());
    assert.equal(harness.getDaily()?.firstIn?.toISOString(), requestedStart.toISOString());
    assert.equal(harness.getDaily()?.lastOut?.toISOString(), actualOut.toISOString());
  });

  it("rejects approval when the requested IN changed after submission without writing a decision", async () => {
    const originalStart = new Date("2026-10-05T03:00:00.000Z");
    const harness = createHarness({
      session: {
        id: "session-stale-in",
        recordId: "record-stale-in",
        mode: "OFFICE",
        startAt: originalStart,
        endAt: null,
      },
    });
    const request = await submit(harness, employeeActor, {
      firstIn: "2026-10-05T03:20:00.000Z",
    });
    await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
    const auditsBefore = structuredClone(harness.audits);
    const notificationsBefore = structuredClone(harness.notifications);
    harness.getSession()!.startAt = new Date("2026-10-05T03:05:00.000Z");

    await assert.rejects(
      decideDailyAttendanceCorrection(independentHrActor, request.id, { action: "APPROVE" }, harness.database),
      DailyAttendanceCorrectionConflictError,
    );

    assert.equal(harness.correctionRequests[0]?.status, AttendanceCorrectionStatus.PENDING);
    assert.equal(harness.correctionRequests[0]?.currentApprovalStage, AttendanceCorrectionApprovalStage.HR);
    assert.equal(harness.getSession()?.startAt.toISOString(), "2026-10-05T03:05:00.000Z");
    assert.equal(harness.getDaily(), null);
    assert.deepEqual(harness.audits, auditsBefore);
    assert.deepEqual(harness.notifications, notificationsBefore);
  });

  it("rejects a conflicting session identity and an unsafe record association", async () => {
    const identityHarness = createHarness({
      session: {
        id: "session-original",
        recordId: "record-original",
        mode: "OFFICE",
        startAt: new Date("2026-10-05T03:00:00.000Z"),
        endAt: null,
      },
    });
    const identityRequest = await submit(identityHarness, employeeActor, {
      firstIn: "2026-10-05T03:20:00.000Z",
    });
    identityHarness.getSession()!.id = "session-replaced";
    await assert.rejects(
      decideDailyAttendanceCorrection(supervisorActor, identityRequest.id, { action: "APPROVE" }, identityHarness.database),
      DailyAttendanceCorrectionConflictError,
    );
    assert.equal(identityRequest.status, AttendanceCorrectionStatus.PENDING);
    assert.equal(identityHarness.audits.length, 1);

    const recordHarness = createHarness({
      session: {
        id: "session-record-association",
        recordId: "record-original",
        mode: "OFFICE",
        startAt: new Date("2026-10-05T03:00:00.000Z"),
        endAt: null,
      },
    });
    const recordRequest = await submit(recordHarness, employeeActor, {
      firstIn: "2026-10-05T03:20:00.000Z",
    });
    recordHarness.records.push({ id: "unrelated-date-record", sessions: [] });
    await assert.rejects(
      decideDailyAttendanceCorrection(supervisorActor, recordRequest.id, { action: "APPROVE" }, recordHarness.database),
      DailyAttendanceCorrectionConflictError,
    );
    assert.equal(recordRequest.status, AttendanceCorrectionStatus.PENDING);
    assert.equal(recordHarness.audits.length, 1);
  });

  it("allows an independent HR reviewer to reject after attendance state changes without mutating attendance", async () => {
    const originalStart = new Date("2026-10-05T03:00:00.000Z");
    const changedStart = new Date("2026-10-05T03:10:00.000Z");
    const harness = createHarness({
      session: {
        id: "session-reject-changed-state",
        recordId: "record-reject-changed-state",
        mode: "WFH",
        startAt: originalStart,
        endAt: null,
      },
    });
    const request = await submit(harness, employeeActor, {
      firstIn: "2026-10-05T03:20:00.000Z",
      mode: "WFH",
    });
    await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
    harness.getSession()!.startAt = changedStart;
    harness.materializeDaily(changedStart, null);
    const sessionBefore = structuredClone(harness.getSession());
    const dailyBefore = structuredClone(harness.getDaily());

    const result = await decideDailyAttendanceCorrection(
      independentHrActor,
      request.id,
      { action: "REJECT", reason: "Reject after review" },
      harness.database,
    );

    assert.equal(result.status, AttendanceCorrectionStatus.REJECTED);
    assert.deepEqual(harness.getSession(), sessionBefore);
    assert.deepEqual(harness.getDaily(), dailyBefore);
    assert.equal(harness.audits.length, 3);
    assert.equal(harness.audits.at(-1)?.actorId, independentHrActor.id);
  });

  it("prevents repeated date-correction decisions from duplicating sessions or audits", async () => {
    const harness = createHarness();
    const request = await submit(harness, employeeActor, {
      firstIn: "2026-10-05T03:20:00.000Z",
      lastOut: "2026-10-05T12:30:00.000Z",
      mode: "WFH",
    });
    await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
    await decideDailyAttendanceCorrection(independentHrActor, request.id, { action: "APPROVE" }, harness.database);
    assert.equal(request.status, AttendanceCorrectionStatus.APPROVED);
    assert.equal(harness.getSession()?.id, "session-created");
    assert.equal(harness.records.filter(({ sessions }) => sessions.length > 0).length, 1);
    assert.equal(harness.audits.length, 3);
    await assert.rejects(
      decideDailyAttendanceCorrection(independentHrActor, request.id, { action: "APPROVE" }, harness.database),
      DailyAttendanceCorrectionStageError,
    );
    assert.equal(harness.audits.length, 3);
    assert.equal(harness.records.filter(({ sessions }) => sessions.length > 0).length, 1);
  });

  it("rolls back a failed final approval without partial attendance, audit, or notification changes", async () => {
    const originalStart = new Date("2026-10-05T03:00:00.000Z");
    const harness = createHarness({
      session: {
        id: "session-rollback",
        recordId: "record-rollback",
        mode: "OFFICE",
        startAt: originalStart,
        endAt: null,
      },
      daily: {
        id: "daily-rollback",
        firstIn: originalStart,
        lastOut: null,
        status: "MISSING_PUNCH",
      },
      failDailyUpdate: true,
    });
    const request = await submit(harness, employeeActor, {
      firstIn: "2026-10-05T03:20:00.000Z",
    });
    await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
    const sessionBefore = structuredClone(harness.getSession());
    const dailyBefore = structuredClone(harness.getDaily());
    const auditsBefore = structuredClone(harness.audits);
    const notificationsBefore = structuredClone(harness.notifications);

    await assert.rejects(
      decideDailyAttendanceCorrection(independentHrActor, request.id, { action: "APPROVE" }, harness.database),
      DailyAttendanceCorrectionConflictError,
    );

    assert.equal(harness.correctionRequests[0]?.status, AttendanceCorrectionStatus.PENDING);
    assert.equal(harness.correctionRequests[0]?.currentApprovalStage, AttendanceCorrectionApprovalStage.HR);
    assert.deepEqual(harness.getSession(), sessionBefore);
    assert.deepEqual(harness.getDaily(), dailyBefore);
    assert.deepEqual(harness.audits, auditsBefore);
    assert.deepEqual(harness.notifications, notificationsBefore);
  });

  for (const mode of ["OFFICE", "WFH"] as const) {
    it(`adds a missed ${mode} IN while retaining a recorded OUT without creating duplicate evidence`, async () => {
      const recordedOut = new Date("2026-10-05T12:41:00.000Z");
      const harness = createHarness({
        daily: {
          id: "daily-out-only",
          firstIn: null,
          lastOut: recordedOut,
          status: "MISSING_PUNCH",
        },
        rawPunches: [{
          timestamp: recordedOut,
          punchType: "OUT",
          workMode: mode === "WFH" ? "OFFICE" : "WFH",
        }],
      });
      const rawEvidenceBefore = structuredClone(harness.raw);
      const request = await submit(harness, employeeActor, {
        firstIn: "2026-10-05T03:19:00.000Z",
        mode,
      });
      await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
      await decideDailyAttendanceCorrection(independentHrActor, request.id, { action: "APPROVE" }, harness.database);

      assert.equal(harness.getSession()?.mode, mode);
      assert.equal(harness.getSession()?.startAt.toISOString(), "2026-10-05T03:19:00.000Z");
      assert.equal(harness.getSession()?.endAt?.toISOString(), recordedOut.toISOString());
      assert.equal(harness.getDaily()?.firstIn?.toISOString(), "2026-10-05T03:19:00.000Z");
      assert.equal(harness.getDaily()?.lastOut?.toISOString(), recordedOut.toISOString());
      assert.deepEqual(harness.raw, rawEvidenceBefore);
    });
  }

  for (const mode of ["OFFICE", "WFH"] as const) {
    it(`repairs a missing ${mode} OUT from raw IN evidence without a session or daily row`, async () => {
      const recordedIn = new Date("2026-10-05T03:17:00.000Z");
      const harness = createHarness({
        rawPunches: [{
          timestamp: recordedIn,
          punchType: "IN",
          workMode: mode === "WFH" ? "OFFICE" : "WFH",
        }],
      });
      const rawEvidenceBefore = structuredClone(harness.raw);
      const request = await submit(harness, employeeActor, {
        lastOut: "2026-10-05T12:43:00.000Z",
        mode,
      });
      await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
      await decideDailyAttendanceCorrection(independentHrActor, request.id, { action: "APPROVE" }, harness.database);

      assert.equal(harness.getSession()?.mode, mode);
      assert.equal(harness.getSession()?.startAt.toISOString(), recordedIn.toISOString());
      assert.equal(harness.getSession()?.endAt?.toISOString(), "2026-10-05T12:43:00.000Z");
      assert.equal(harness.getDaily()?.firstIn?.toISOString(), recordedIn.toISOString());
      assert.equal(harness.getDaily()?.lastOut?.toISOString(), "2026-10-05T12:43:00.000Z");
      assert.deepEqual(harness.raw, rawEvidenceBefore);
    });
  }

  it("repairs a missing session when only the original OUT evidence exists and no daily row was calculated", async () => {
    const recordedOut = new Date("2026-10-05T12:41:00.000Z");
    const harness = createHarness({
      rawPunches: [{ timestamp: recordedOut, punchType: "OUT", workMode: "OFFICE" }],
    });
    const rawEvidenceBefore = structuredClone(harness.raw);
    const request = await submit(harness, employeeActor, {
      firstIn: "2026-10-05T03:19:00.000Z",
      mode: "WFH",
    });
    await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
    await decideDailyAttendanceCorrection(independentHrActor, request.id, { action: "APPROVE" }, harness.database);

    assert.equal(harness.getSession()?.mode, "WFH");
    assert.equal(harness.getSession()?.startAt.toISOString(), "2026-10-05T03:19:00.000Z");
    assert.equal(harness.getSession()?.endAt?.toISOString(), recordedOut.toISOString());
    assert.equal(harness.getDaily()?.lastOut?.toISOString(), recordedOut.toISOString());
    assert.deepEqual(harness.raw, rawEvidenceBefore);
  });

  it("rejects a date-scoped record that already contains an unrelated session", async () => {
    const harness = createHarness({ emptyRecordId: "occupied-record" });
    harness.records[0]?.sessions.push({ id: "unrelated-session" });

    await assert.rejects(
      submit(harness, employeeActor, {
        firstIn: "2026-10-05T03:23:00.000Z",
        lastOut: "2026-10-05T12:52:00.000Z",
      }),
      DailyAttendanceCorrectionInvalidValuesError,
    );
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.session, null);
    assert.equal(harness.daily, null);
  });

  it("rejects a stale approval if an empty record gains a session after submission", async () => {
    const harness = createHarness({ emptyRecordId: "empty-record" });
    const request = await submit(harness, employeeActor, {
      firstIn: "2026-10-05T03:23:00.000Z",
      lastOut: "2026-10-05T12:52:00.000Z",
    });
    harness.records[0]?.sessions.push({ id: "concurrent-session" });

    await assert.rejects(
      decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database),
      DailyAttendanceCorrectionConflictError,
    );
    assert.equal(request.status, AttendanceCorrectionStatus.PENDING);
    assert.equal(request.currentApprovalStage, AttendanceCorrectionApprovalStage.SUPERVISOR);
  });

  for (const mode of ["OFFICE", "WFH"] as const) {
    it(`creates a complete ${mode} session for a date with no prior punches, session, or daily row`, async () => {
      const harness = createHarness();
      const rawEvidenceBefore = structuredClone(harness.raw);
      const request = await submit(harness, employeeActor, {
        firstIn: "2026-10-05T03:23:00.000Z",
        lastOut: "2026-10-05T12:52:00.000Z",
        mode,
      });
      await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
      await decideDailyAttendanceCorrection(independentHrActor, request.id, { action: "APPROVE" }, harness.database);

      assert.equal(harness.getSession()?.mode, mode);
      assert.equal(harness.getSession()?.startAt.toISOString(), "2026-10-05T03:23:00.000Z");
      assert.equal(harness.getSession()?.endAt?.toISOString(), "2026-10-05T12:52:00.000Z");
      assert.equal(harness.getDaily()?.firstIn?.toISOString(), "2026-10-05T03:23:00.000Z");
      assert.equal(harness.getDaily()?.lastOut?.toISOString(), "2026-10-05T12:52:00.000Z");
      assert.deepEqual(harness.raw, rawEvidenceBefore);
    });

    it(`reuses an existing empty AttendanceRecord for ${mode} correction`, async () => {
      const harness = createHarness({ emptyRecordId: "existing-empty-record" });
      const request = await submit(harness, employeeActor, {
        firstIn: "2026-10-05T03:23:00.000Z",
        lastOut: "2026-10-05T12:52:00.000Z",
        mode,
      });
      await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
      await decideDailyAttendanceCorrection(independentHrActor, request.id, { action: "APPROVE" }, harness.database);

      assert.equal(harness.getSession()?.recordId, "existing-empty-record");
      assert.deepEqual(harness.records, [{
        id: "existing-empty-record",
        sessions: [{ id: "session-created" }],
      }]);
    });

    it(`adds a missing ${mode} OUT to an existing open session`, async () => {
      const startAt = new Date("2026-10-05T03:11:00.000Z");
      const harness = createHarness({
        session: { id: "session-open", recordId: "record-open", mode, startAt, endAt: null },
        daily: {
          id: "daily-in-only",
          firstIn: startAt,
          lastOut: null,
          status: "MISSING_PUNCH",
        },
      });
      const rawEvidenceBefore = structuredClone(harness.raw);
      const request = await submit(harness, employeeActor, {
        lastOut: "2026-10-05T12:23:00.000Z",
        mode,
      });
      await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
      await decideDailyAttendanceCorrection(independentHrActor, request.id, { action: "APPROVE" }, harness.database);

      assert.equal(harness.getSession()?.startAt.toISOString(), startAt.toISOString());
      assert.equal(harness.getSession()?.endAt?.toISOString(), "2026-10-05T12:23:00.000Z");
      assert.equal(harness.getDaily()?.firstIn?.toISOString(), startAt.toISOString());
      assert.equal(harness.getDaily()?.lastOut?.toISOString(), "2026-10-05T12:23:00.000Z");
      assert.deepEqual(harness.raw, rawEvidenceBefore);
    });
  }

  it("does not apply a pending or rejected correction to an absent session or daily row", async () => {
    const harness = createHarness();
    const request = await submit(harness, employeeActor, {
      firstIn: "2026-10-05T04:08:00.000Z",
      mode: "OFFICE",
    });
    assert.equal(harness.getSession(), null);
    assert.equal(harness.getDaily(), null);

    const result = await decideDailyAttendanceCorrection(
      supervisorActor,
      request.id,
      { action: "REJECT", reason: "Please confirm the actual punch time." },
      harness.database,
    );
    assert.equal(result.status, AttendanceCorrectionStatus.REJECTED);
    assert.equal(harness.getSession(), null);
    assert.equal(harness.getDaily(), null);
    assert.deepEqual(harness.raw, []);
  });

  it("corrects an existing OUT while preserving the recorded IN", async () => {
    const harness = createHarness({
      session: {
        id: "session-complete",
        recordId: "record-complete",
        mode: "OFFICE",
        startAt: new Date("2026-10-05T03:10:00.000Z"),
        endAt: new Date("2026-10-05T12:00:00.000Z"),
      },
      daily: {
        id: "daily-complete",
        firstIn: new Date("2026-10-05T03:10:00.000Z"),
        lastOut: new Date("2026-10-05T12:00:00.000Z"),
        status: "PRESENT",
      },
    });
    const rawEvidenceBefore = structuredClone(harness.raw);
    const request = await submit(harness, employeeActor, {
      lastOut: "2026-10-05T12:37:00.000Z",
      mode: "OFFICE",
    });
    await decideDailyAttendanceCorrection(supervisorActor, request.id, { action: "APPROVE" }, harness.database);
    await decideDailyAttendanceCorrection(independentHrActor, request.id, { action: "APPROVE" }, harness.database);

    assert.equal(harness.getSession()?.startAt.toISOString(), "2026-10-05T03:10:00.000Z");
    assert.equal(harness.getSession()?.endAt?.toISOString(), "2026-10-05T12:37:00.000Z");
    assert.equal(harness.getDaily()?.firstIn?.toISOString(), "2026-10-05T03:10:00.000Z");
    assert.equal(harness.getDaily()?.lastOut?.toISOString(), "2026-10-05T12:37:00.000Z");
    assert.deepEqual(harness.raw, rawEvidenceBefore);
  });

  it("rejects duplicate pending requests, reversed times, and timestamps outside the selected local date", async () => {
    const harness = createHarness();
    await submit(harness, employeeActor, {
      firstIn: "2026-10-05T03:00:00.000Z",
      lastOut: "2026-10-05T12:00:00.000Z",
    });
    await assert.rejects(
      submit(harness, employeeActor, {
        firstIn: "2026-10-05T03:00:00.000Z",
        mode: "WFH",
      }),
      DailyAttendanceCorrectionPendingRequestExistsError,
    );
    const unoccupiedDate = createHarness();
    await assert.rejects(
      submit(unoccupiedDate, employeeActor, {
        firstIn: "2026-10-05T12:00:00.000Z",
        lastOut: "2026-10-05T03:00:00.000Z",
      }),
      DailyAttendanceCorrectionInvalidValuesError,
    );
    await assert.rejects(
      submit(unoccupiedDate, employeeActor, { firstIn: "2026-10-06T03:00:00.000Z" }),
      DailyAttendanceCorrectionInvalidValuesError,
    );
  });

  it("requires a linked Employee record and limits HR history to the logged-in HR account", async () => {
    const unlinked = createHarness({ ownerId: hrActor.id, ownerRole: Role.HR_ADMINISTRATOR, employeeLinked: false });
    await assert.rejects(
      submit(unlinked, hrActor, { firstIn: "2026-10-05T03:00:00.000Z" }),
      /linked Employee record/,
    );

    const ownRequest = createHarness({ ownerId: hrActor.id, ownerRole: Role.HR_ADMINISTRATOR });
    const request = await submit(ownRequest, hrActor, { firstIn: "2026-10-05T03:00:00.000Z" });
    const history = await listOwnAttendanceCorrectionHistory(hrActor, ownRequest.historyDatabase);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.id, request.id);
    await assert.rejects(
      listOwnAttendanceCorrectionHistory(
        { id: "manager", role: Role.DEPARTMENT_MANAGER },
        ownRequest.historyDatabase,
      ),
      DailyAttendanceCorrectionAccessError,
    );
  });
});
