import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { Role } from "@prisma/client";
import { prisma } from "../prisma";
import { correctAdminAttendance, AdminAttendanceCorrectionError } from "./admin-service";
import { applyAttendanceAction as applyAttendanceActionWithLocation, AttendanceStateError } from "./service";
import { getEmployeeLocalDayWindow } from "./timezone";
import type { AttendanceAction } from "./validation";

const enabled = process.env.ATTENDANCE_POSTGRES_INTEGRATION === "1";
const testLocation = { latitude: 6.9271, longitude: 79.8612, accuracy: 12.5 };

function applyAttendanceAction(employeeId: string, action: AttendanceAction, database = prisma, now?: Date) {
  return applyAttendanceActionWithLocation(employeeId, action, testLocation, database, now);
}

it("serializes real concurrent actions and admin reopen corrections in PostgreSQL", { skip: !enabled }, async () => {
  const databaseName = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
  assert.match(databaseName, /^attendance_step10_[a-f0-9]+$/, "integration test requires a disposable Step 10 database");

  const unique = randomUUID();
  let employeeId: string | undefined;
  let employeeRecordId: string | undefined;
  try {
    const employee = await prisma.user.create({
      data: {
        name: "Step 10 concurrency test",
        email: `step10-${unique}@example.invalid`,
        employeeCode: `STEP10-${unique}`,
        countryCode: "LK",
        timeZone: "Asia/Colombo",
        passwordHash: "integration-test-only",
        role: Role.EMPLOYEE,
      },
      select: { id: true },
    });
    employeeId = employee.id;
    const employeeRecord = await prisma.employee.create({
      data: { name: "Step 10 concurrency test", userId: employee.id, employeeId: `STEP10-RECORD-${unique}` },
      select: { id: true },
    });
    employeeRecordId = employeeRecord.id;
    const actionTime = new Date();

    const concurrentStarts = await Promise.allSettled([
      applyAttendanceAction(employeeId, "IN", prisma, actionTime),
      applyAttendanceAction(employeeId, "IN", prisma, actionTime),
    ]);
    assert.equal(concurrentStarts.filter((result) => result.status === "fulfilled").length, 1);
    const rejectedStart = concurrentStarts.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(rejectedStart?.reason instanceof AttendanceStateError);

    const openSessions = () => prisma.workSession.findMany({
      where: { record: { employeeId }, endAt: null },
      select: { id: true },
    });
    assert.equal((await openSessions()).length, 1);
    assert.equal(await prisma.attendanceRaw.count({ where: { employeeId: employeeRecord.id, punchType: "IN" } }), 1);
    assert.equal(await prisma.attendanceRaw.count({ where: { employeeId: employeeRecord.id, punchType: "IN", workMode: "OFFICE" } }), 1);

    const concurrentEnds = await Promise.allSettled([
      applyAttendanceAction(employeeId, "OUT", prisma, actionTime),
      applyAttendanceAction(employeeId, "OUT", prisma, actionTime),
    ]);
    assert.equal(concurrentEnds.filter((result) => result.status === "fulfilled").length, 1);
    const rejectedEnd = concurrentEnds.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(rejectedEnd?.reason instanceof AttendanceStateError);
    assert.equal((await openSessions()).length, 0);
    assert.equal(await prisma.attendanceRaw.count({ where: { employeeId: employeeRecord.id, punchType: "OUT" } }), 1);
    assert.equal(await prisma.attendanceRaw.count({ where: { employeeId: employeeRecord.id, punchType: "OUT", workMode: "OFFICE" } }), 1);
    assert.equal(await prisma.attendanceRaw.count({ where: { employeeId: employeeRecord.id } }), 2);

    const completedSession = await prisma.workSession.findFirst({
      where: { record: { employeeId }, endAt: { not: null } },
      select: { id: true },
    });
    assert.ok(completedSession);

    const sameDayStarts = await Promise.allSettled([
      applyAttendanceAction(employeeId, "IN", prisma, actionTime),
      applyAttendanceAction(employeeId, "WFH_IN", prisma, actionTime),
    ]);
    assert.equal(sameDayStarts.filter((result) => result.status === "fulfilled").length, 0);
    assert.ok(sameDayStarts.every((result) => result.status === "rejected" && result.reason instanceof AttendanceStateError));

    const concurrentReopen = await Promise.allSettled([
      correctAdminAttendance({ role: Role.ADMIN }, completedSession.id, { endAt: "", reason: "Exercise row-lock race" }),
      applyAttendanceAction(employeeId, "WFH_IN", prisma, actionTime),
    ]);
    assert.equal(concurrentReopen.filter((result) => result.status === "fulfilled").length, 1);
    const rejectedReopen = concurrentReopen.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(rejectedReopen?.reason instanceof AttendanceStateError || rejectedReopen?.reason instanceof AdminAttendanceCorrectionError);
    assert.equal((await openSessions()).length, 1);

    const active = await prisma.workSession.findFirst({ where: { record: { employeeId }, endAt: null }, select: { id: true } });
    assert.ok(active);
    await prisma.workSession.update({ where: { id: active.id }, data: { endAt: new Date(actionTime.getTime() + 60_000) } });
    const nextLocalDay = getEmployeeLocalDayWindow(actionTime, "Asia/Colombo").endAt;
    await applyAttendanceAction(employeeId, "WFH_IN", prisma, nextLocalDay);
    assert.equal((await openSessions()).length, 1);
    assert.equal(await prisma.attendanceRaw.count({
      where: { employeeId: employeeRecord.id, timestamp: nextLocalDay, punchType: "IN", workMode: "WFH" },
    }), 1);
    const wfhEnd = new Date(nextLocalDay.getTime() + 60_000);
    await applyAttendanceAction(employeeId, "WFH_OUT", prisma, wfhEnd);
    assert.equal(await prisma.attendanceRaw.count({
      where: { employeeId: employeeRecord.id, timestamp: wfhEnd, punchType: "OUT", workMode: "WFH" },
    }), 1);
  } finally {
    if (employeeRecordId) {
      const tasks = await prisma.attendanceDailyCalculationTask.findMany({
        where: { employeeId: employeeRecordId },
        select: { id: true },
      });
      await prisma.attendanceDailyCalculationTaskEvent.deleteMany({
        where: { taskId: { in: tasks.map(({ id }) => id) } },
      });
      await prisma.attendanceDailyCalculationTask.deleteMany({ where: { employeeId: employeeRecordId } });
      await prisma.attendanceRaw.deleteMany({ where: { employeeId: employeeRecordId } });
      await prisma.employee.delete({ where: { id: employeeRecordId } });
    }
    if (employeeId) await prisma.user.delete({ where: { id: employeeId } });
    await prisma.$disconnect();
  }
});