import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import {
  AttendanceCorrectionApprovalStage,
  AttendanceCorrectionStatus,
  Role,
} from "@prisma/client";
import { prisma } from "../prisma";
import { decideDailyAttendanceCorrection } from "./correction-service";
import { enqueueDailyAttendanceCalculation } from "./daily-reconciliation-queue";
import { runAttendanceReconciliationWorker } from "./daily-reconciliation-queue";
import { applyAttendanceAction } from "./service";

const enabled = process.env.ATTENDANCE_POSTGRES_INTEGRATION === "1";
const location = { latitude: 6.9271, longitude: 79.8612, accuracy: 12.5 };

function assertDisposableDatabase() {
  const databaseName = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
  assert.match(databaseName, /^attendance_step10_[a-f0-9]+$/, "integration test requires the isolated disposable Step 10 database");
}

async function createFixture(suffix: string, withShift = true) {
  const user = await prisma.user.create({
    data: {
      name: "Reconciliation integration",
      email: `reconcile-${suffix}@example.invalid`,
      employeeCode: `REC-${suffix}`,
      countryCode: "LK",
      timeZone: "UTC",
      passwordHash: "integration-test-only",
      role: Role.EMPLOYEE,
    },
    select: { id: true },
  });
  const shift = withShift
    ? await prisma.shift.create({
        data: {
          name: `Reconciliation ${suffix}`,
          startTime: new Date("1970-01-01T08:30:00.000Z"),
          endTime: new Date("1970-01-01T17:30:00.000Z"),
          gracePeriodMinutes: 0,
          lateThresholdMinutes: 0,
          earlyDepartureThresholdMinutes: 0,
          breakDurationMinutes: 0,
          minimumWorkingHours: 8,
          overtimeEligible: false,
          workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
        },
        select: { id: true },
      })
    : null;
  const employee = await prisma.employee.create({
    data: {
      name: "Reconciliation integration",
      userId: user.id,
      employeeId: `REC-RECORD-${suffix}`,
      ...(shift ? { shiftId: shift.id } : {}),
    },
    select: { id: true },
  });
  return { userId: user.id, employeeId: employee.id, shiftId: shift?.id };
}

async function cleanupFixture(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const tasks = await prisma.attendanceDailyCalculationTask.findMany({
    where: { employeeId: fixture.employeeId },
    select: { id: true },
  });
  await prisma.attendanceDailyCalculationTaskEvent.deleteMany({
    where: { taskId: { in: tasks.map(({ id }) => id) } },
  });
  await prisma.attendanceDailyCalculationTask.deleteMany({ where: { employeeId: fixture.employeeId } });
  const corrections = await prisma.attendanceCorrectionRequest.findMany({
    where: { employeeId: fixture.userId },
    select: { id: true },
  });
  await prisma.attendanceAuditLog.deleteMany({ where: { correctionRequestId: { in: corrections.map(({ id }) => id) } } });
  await prisma.attendanceCorrectionRequest.deleteMany({ where: { employeeId: fixture.userId } });
  await prisma.attendanceDaily.deleteMany({ where: { employeeId: fixture.employeeId } });
  await prisma.attendanceRaw.deleteMany({ where: { employeeId: fixture.employeeId } });
  await prisma.attendanceRecord.deleteMany({ where: { employeeId: fixture.userId } });
  await prisma.employee.delete({ where: { id: fixture.employeeId } });
  await prisma.user.delete({ where: { id: fixture.userId } });
  if (fixture.shiftId) await prisma.shift.delete({ where: { id: fixture.shiftId } });
}

it("persists punches atomically with outbox work and serializes concurrent reconciliation in PostgreSQL", { skip: !enabled }, async () => {
  assertDisposableDatabase();
  const unique = randomUUID().replaceAll("-", "");
  const fixture = await createFixture(unique);
  const startAt = new Date("2026-06-15T08:30:00.000Z");
  const endAt = new Date("2026-06-15T17:30:00.000Z");

  try {
    await applyAttendanceAction(fixture.userId, "IN", location, prisma, startAt);
    const taskAfterStart = await prisma.attendanceDailyCalculationTask.findUniqueOrThrow({
      where: { employeeId_attendanceDate: { employeeId: fixture.employeeId, attendanceDate: new Date("2026-06-15T00:00:00.000Z") } },
    });
    assert.equal(taskAfterStart.requestedVersion, 1);

    const workers = runAttendanceReconciliationWorker(new Date());
    const punchOut = applyAttendanceAction(fixture.userId, "OUT", location, prisma, endAt);
    await Promise.all([workers, punchOut]);
    const outPunch = await prisma.attendanceRaw.findFirstOrThrow({
      where: { employeeId: fixture.employeeId, punchType: "OUT", timestamp: endAt },
      select: { id: true },
    });
    await prisma.$transaction((transaction) => enqueueDailyAttendanceCalculation(transaction, {
      employeeId: fixture.employeeId,
      attendanceDate: "2026-06-15",
      timeZone: "UTC",
      punchId: outPunch.id,
    }));
    const versionAfterDuplicate = await prisma.attendanceDailyCalculationTask.findUniqueOrThrow({
      where: { employeeId_attendanceDate: { employeeId: fixture.employeeId, attendanceDate: new Date("2026-06-15T00:00:00.000Z") } },
      select: { requestedVersion: true },
    });
    assert.equal(versionAfterDuplicate.requestedVersion, 2);
    await Promise.all([
      runAttendanceReconciliationWorker(new Date()),
      runAttendanceReconciliationWorker(new Date()),
    ]);

    const task = await prisma.attendanceDailyCalculationTask.findUniqueOrThrow({
      where: { employeeId_attendanceDate: { employeeId: fixture.employeeId, attendanceDate: new Date("2026-06-15T00:00:00.000Z") } },
    });
    const daily = await prisma.attendanceDaily.findFirstOrThrow({
      where: { employeeId: fixture.employeeId, date: new Date("2026-06-15T00:00:00.000Z") },
    });
    assert.equal(task.status, "COMPLETED");
    assert.equal(task.completedVersion, task.requestedVersion);
    assert.equal(daily.status, "PRESENT");
    assert.equal(await prisma.attendanceDailyCalculationTask.count({ where: { employeeId: fixture.employeeId } }), 1);
  } finally {
    await cleanupFixture(fixture);
    await prisma.$disconnect();
  }
});

it("rolls a punch back if the outbox insert fails in the same PostgreSQL transaction", { skip: !enabled }, async () => {
  assertDisposableDatabase();
  const unique = randomUUID().replaceAll("-", "");
  const fixture = await createFixture(unique, false);
  const trigger = `fail_reconciliation_${unique}`;
  const functionName = `fail_reconciliation_fn_${unique}`;

  try {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test outbox failure'; END; $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${trigger}" BEFORE INSERT ON "attendance_daily_calculation_tasks"
      FOR EACH ROW WHEN (NEW."employeeId" = '${fixture.employeeId}')
      EXECUTE FUNCTION "${functionName}"()
    `);

    await assert.rejects(
      applyAttendanceAction(fixture.userId, "IN", location, prisma, new Date("2026-06-15T08:30:00.000Z")),
    );
    assert.equal(await prisma.attendanceRecord.count({ where: { employeeId: fixture.userId } }), 0);
    assert.equal(await prisma.attendanceRaw.count({ where: { employeeId: fixture.employeeId } }), 0);
    assert.equal(await prisma.attendanceDailyCalculationTask.count({ where: { employeeId: fixture.employeeId } }), 0);
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "attendance_daily_calculation_tasks"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    await cleanupFixture(fixture);
    await prisma.$disconnect();
  }
});

it("keeps an already committed punch when later daily calculation fails and preserves the durable retry", { skip: !enabled }, async () => {
  assertDisposableDatabase();
  const unique = randomUUID().replaceAll("-", "");
  const fixture = await createFixture(unique, false);

  try {
    await applyAttendanceAction(fixture.userId, "IN", location, prisma, new Date("2026-06-15T08:30:00.000Z"));
    const summary = await runAttendanceReconciliationWorker(new Date());

    assert.equal(await prisma.attendanceRaw.count({ where: { employeeId: fixture.employeeId } }), 1);
    assert.equal(summary.retried, 1);
    const task = await prisma.attendanceDailyCalculationTask.findFirstOrThrow({ where: { employeeId: fixture.employeeId } });
    assert.equal(task.status, "RETRY_WAIT");
    assert.equal(task.attempts, 1);
  } finally {
    await cleanupFixture(fixture);
    await prisma.$disconnect();
  }
});

it("recovers an expired final lease, dead-letters exhausted work, and permits exact operator requeue", { skip: !enabled }, async () => {
  assertDisposableDatabase();
  const unique = randomUUID().replaceAll("-", "");
  const fixture = await createFixture(unique, false);

  try {
    await applyAttendanceAction(fixture.userId, "IN", location, prisma, new Date("2026-06-15T08:30:00.000Z"));
    const task = await prisma.attendanceDailyCalculationTask.findFirstOrThrow({ where: { employeeId: fixture.employeeId } });
    await prisma.attendanceDailyCalculationTask.update({
      where: { id: task.id },
      data: {
        status: "PROCESSING",
        attempts: 7,
        claimedVersion: task.requestedVersion,
        leaseToken: "expired-lease",
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });

    const summary = await runAttendanceReconciliationWorker(new Date());
    const deadLetter = await prisma.attendanceDailyCalculationTask.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(summary.deadLettered, 1);
    assert.equal(deadLetter.status, "DEAD_LETTER");
    assert.equal(deadLetter.attempts, 8);

    await prisma.attendanceDailyCalculationTask.updateMany({
      where: { id: task.id, status: "DEAD_LETTER" },
      data: {
        status: "PENDING",
        attempts: 0,
        availableAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        claimedVersion: null,
        lastErrorCategory: null,
      },
    });
    await runAttendanceReconciliationWorker(new Date());
    const requeued = await prisma.attendanceDailyCalculationTask.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(requeued.status, "RETRY_WAIT");
    assert.equal(requeued.attempts, 1);
  } finally {
    await cleanupFixture(fixture);
    await prisma.$disconnect();
  }
});

it("does not calculate tasks after account deactivation or employee unlinking", { skip: !enabled }, async () => {
  assertDisposableDatabase();
  const inactiveFixture = await createFixture(randomUUID().replaceAll("-", ""), true);
  const unlinkedFixture = await createFixture(randomUUID().replaceAll("-", ""), true);

  try {
    await applyAttendanceAction(inactiveFixture.userId, "IN", location, prisma, new Date("2026-06-15T08:30:00.000Z"));
    await applyAttendanceAction(unlinkedFixture.userId, "IN", location, prisma, new Date("2026-06-15T08:30:00.000Z"));
    await prisma.user.update({ where: { id: inactiveFixture.userId }, data: { isActive: false } });
    await prisma.employee.update({ where: { id: unlinkedFixture.employeeId }, data: { userId: null } });

    const summary = await runAttendanceReconciliationWorker(new Date());
    assert.equal(summary.skippedInactive, 1);
    assert.equal(summary.unlinkedEmployees, 1);
    assert.equal(await prisma.attendanceDaily.count({
      where: { employeeId: { in: [inactiveFixture.employeeId, unlinkedFixture.employeeId] } },
    }), 0);
  } finally {
    await cleanupFixture(inactiveFixture);
    await cleanupFixture(unlinkedFixture);
    await prisma.$disconnect();
  }
});

it("serializes final correction approval with reconciliation using User then Employee locks", { skip: !enabled }, async () => {
  assertDisposableDatabase();
  const unique = randomUUID().replaceAll("-", "");
  const fixture = await createFixture(unique, true);
  const reviewer = await prisma.user.create({
    data: {
      name: "Reconciliation reviewer",
      email: `reviewer-${unique}@example.invalid`,
      countryCode: "LK",
      timeZone: "UTC",
      passwordHash: "integration-test-only",
      role: Role.HR_ADMINISTRATOR,
    },
    select: { id: true },
  });

  try {
    await applyAttendanceAction(fixture.userId, "IN", location, prisma, new Date("2026-06-15T08:30:00.000Z"));
    await applyAttendanceAction(fixture.userId, "OUT", location, prisma, new Date("2026-06-15T17:30:00.000Z"));
    await runAttendanceReconciliationWorker(new Date());
    const daily = await prisma.attendanceDaily.findFirstOrThrow({
      where: { employeeId: fixture.employeeId, date: new Date("2026-06-15T00:00:00.000Z") },
    });
    const correction = await prisma.attendanceCorrectionRequest.create({
      data: {
        employeeId: fixture.userId,
        requesterId: fixture.userId,
        dailyAttendanceId: daily.id,
        reason: "Concurrency test",
        status: AttendanceCorrectionStatus.PENDING,
        currentApprovalStage: AttendanceCorrectionApprovalStage.HR,
        originalValues: { firstIn: daily.firstIn?.toISOString() ?? null, lastOut: daily.lastOut?.toISOString() ?? null },
        requestedValues: { lastOut: daily.lastOut?.toISOString() ?? null },
      },
      select: { id: true },
    });
    const extraPunch = await prisma.attendanceRaw.create({
      data: {
        employeeId: fixture.employeeId,
        timestamp: new Date("2026-06-15T17:31:00.000Z"),
        punchType: "IN",
        source: "INTEGRATION",
      },
      select: { id: true },
    });
    await prisma.$transaction((transaction) => enqueueDailyAttendanceCalculation(transaction, {
      employeeId: fixture.employeeId,
      attendanceDate: "2026-06-15",
      timeZone: "UTC",
      punchId: extraPunch.id,
    }));

    const results = await Promise.allSettled([
      runAttendanceReconciliationWorker(new Date()),
      decideDailyAttendanceCorrection(
        { id: reviewer.id, role: Role.HR_ADMINISTRATOR },
        correction.id,
        { action: "APPROVE" },
        prisma,
      ),
    ]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 2);
    const updatedCorrection = await prisma.attendanceCorrectionRequest.findUniqueOrThrow({
      where: { id: correction.id },
      select: { status: true },
    });
    assert.equal(updatedCorrection.status, AttendanceCorrectionStatus.APPROVED);
    const task = await prisma.attendanceDailyCalculationTask.findFirstOrThrow({ where: { employeeId: fixture.employeeId } });
    assert.ok(task.status === "PROTECTED" || task.status === "COMPLETED");
  } finally {
    await cleanupFixture(fixture);
    await prisma.user.delete({ where: { id: reviewer.id } });
    await prisma.$disconnect();
  }
});
