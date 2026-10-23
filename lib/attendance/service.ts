import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { attendanceLocationSchema, type AttendanceAction, type AttendanceLocation } from "@/lib/attendance/validation";
import { classifySessionForShiftAssignments, groupSessionsByEmployeeLocalDay } from "@/lib/attendance/history";
import type { WorkSessionTiming } from "@/lib/attendance/schedule";
import type { EffectiveShiftAssignment } from "@/lib/attendance/shift-assignment";
import { getEmployeeLocalDayWindow } from "@/lib/attendance/timezone";

export class AttendanceStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendanceStateError";
  }
}

function requestedMode(action: AttendanceAction) {
  return action.startsWith("WFH") ? "WFH" : "OFFICE";
}

export async function lockAttendanceEmployee(tx: Prisma.TransactionClient, employeeId: string) {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${employeeId} FOR UPDATE`;
}

type AttendanceWriteDatabase = Pick<typeof prisma, "$transaction">;

const attendanceCaptureSource = "WEB";

export async function applyAttendanceAction(
  employeeId: string,
  action: AttendanceAction,
  locationInput: unknown,
  database: AttendanceWriteDatabase = prisma,
  now: Date = new Date(),
) {
  const locationResult = attendanceLocationSchema.safeParse(locationInput);
  if (!locationResult.success) {
    throw new AttendanceStateError("A valid device location is required to record attendance.");
  }
  if (!Number.isFinite(now.getTime())) {
    throw new AttendanceStateError("A valid server timestamp is required to record attendance.");
  }
  const location: AttendanceLocation = locationResult.data;
  const mode = requestedMode(action);
  const isStart = action === "IN" || action === "WFH_IN";

  return database.$transaction(async (tx) => {
    await lockAttendanceEmployee(tx, employeeId);

    const employee = await tx.user.findUnique({
      where: { id: employeeId },
      select: { timeZone: true },
    });
    if (!employee) throw new AttendanceStateError("Employee account was not found.");
    const employeeRecord = await tx.employee.findUnique({
      where: { userId: employeeId },
      select: { id: true },
    });
    if (!employeeRecord) {
      throw new AttendanceStateError("An Employee record is required before recording attendance.");
    }

    const activeSession = await tx.workSession.findFirst({
      where: { record: { employeeId }, endAt: null },
      orderBy: { startAt: "desc" },
      select: { id: true, mode: true, startAt: true },
    });

    if (isStart) {
      if (activeSession) {
        throw new AttendanceStateError("End the active session before starting another.");
      }

      const { startAt, endAt } = getEmployeeLocalDayWindow(now, employee.timeZone);
      const todaysSession = await tx.workSession.findFirst({
        where: {
          record: { employeeId },
          OR: [
            { startAt: { gte: startAt, lt: endAt } },
            { endAt: { gte: startAt, lt: endAt } },
          ],
        },
        select: { id: true },
      });
      if (todaysSession) {
        throw new AttendanceStateError("You have already completed attendance for your local day.");
      }

      const startedAt = now;
      // Phase 1 creates one record per session; records do not yet represent attendance days.
      const record = await tx.attendanceRecord.create({
        data: {
          employeeId,
          sessions: { create: { mode, startAt: startedAt } },
        },
        include: { sessions: true },
      });
      await tx.attendanceRaw.create({
        data: {
          employeeId: employeeRecord.id,
          timestamp: startedAt,
          punchType: "IN",
          workMode: mode,
          source: attendanceCaptureSource,
          deviceId: null,
          location,
        },
        select: { id: true },
      });
      return record.sessions[0];
    }

    if (!activeSession) {
      throw new AttendanceStateError("There is no active session to end.");
    }
    if (activeSession.mode !== mode) {
      throw new AttendanceStateError("The active session uses a different work mode.");
    }

    const endedAt = now;
    if (!Number.isFinite(endedAt.getTime()) || endedAt < activeSession.startAt) {
      throw new AttendanceStateError("The session cannot end before it started.");
    }

    const updatedSession = await tx.workSession.update({
      where: { id: activeSession.id },
      data: { endAt: endedAt },
    });
    await tx.attendanceRaw.create({
      data: {
        employeeId: employeeRecord.id,
        timestamp: endedAt,
        punchType: "OUT",
        workMode: mode,
        source: attendanceCaptureSource,
        deviceId: null,
        location,
      },
      select: { id: true },
    });
    return updatedSession;
  });
}

type EmployeeAttendanceContext = { id: string; timeZone: string; countryCode?: string };
type AttendanceReadDatabase = Pick<typeof prisma, "workSession" | "employee">;

async function employeeShiftAssignments(
  employeeId: string,
  database: AttendanceReadDatabase,
): Promise<{ employeeRecordFound: boolean; assignments: EffectiveShiftAssignment[] }> {
  const employeeRecord = await database.employee.findUnique({
    where: { userId: employeeId },
    select: {
      shift: { select: { id: true, startTime: true, endTime: true, gracePeriodMinutes: true, workingDays: true } },
      shiftAssignments: {
        select: {
          effectiveFrom: true,
          effectiveTo: true,
          shift: { select: { id: true, startTime: true, endTime: true, gracePeriodMinutes: true, workingDays: true } },
        },
      },
    },
  });
  if (!employeeRecord) return { employeeRecordFound: false, assignments: [] };
  const assignments = employeeRecord.shiftAssignments.length > 0
    ? employeeRecord.shiftAssignments
    : employeeRecord.shift
      ? [{
        effectiveFrom: new Date("0001-01-01T00:00:00.000Z"),
        effectiveTo: null,
        shift: employeeRecord.shift,
      }]
      : [];
  return { employeeRecordFound: true, assignments };
}

export async function getEmployeeAttendanceDashboard(
  employee: EmployeeAttendanceContext,
  now: Date = new Date(),
  database: AttendanceReadDatabase = prisma,
) {
  const { date, startAt, endAt } = getEmployeeLocalDayWindow(now, employee.timeZone);
  const employeeFilter = { record: { employeeId: employee.id } };
  const [activeSession, sessions, shiftResolution] = await Promise.all([
    database.workSession.findFirst({
      where: { ...employeeFilter, endAt: null },
      orderBy: { startAt: "desc" },
    }),
    database.workSession.findMany({
      where: {
        ...employeeFilter,
        OR: [
          { startAt: { gte: startAt, lt: endAt } },
          { endAt: { gte: startAt, lt: endAt } },
        ],
      },
      orderBy: { startAt: "asc" },
    }),
    employeeShiftAssignments(employee.id, database),
  ]);

  const todaySessions = sessions.filter((session) => session.startAt >= startAt && session.startAt < endAt);
  const grouped = groupSessionsByEmployeeLocalDay(todaySessions, employee.timeZone, shiftResolution.assignments, employee.countryCode);
  const sessionTiming = (session: NonNullable<typeof activeSession>): WorkSessionTiming => {
    return classifySessionForShiftAssignments(session, employee.timeZone, shiftResolution.assignments, employee.countryCode);
  };
  const activeSessionTiming = activeSession ? sessionTiming(activeSession) : null;
  const previousDayActiveSessionTiming = activeSession && activeSession.startAt < startAt
    ? sessionTiming(activeSession)
    : null;
  const completedSessionToday = sessions.some((session) => session.endAt && session.endAt >= startAt && session.endAt < endAt);
  return {
    date,
    employeeRecordFound: shiftResolution.employeeRecordFound,
    activeSession: activeSession && activeSession.startAt >= startAt && activeSession.startAt < endAt
      ? activeSession
      : null,
    previousDayActiveSession: activeSession && activeSession.startAt < startAt
      ? activeSession
      : null,
    activeSessionTiming,
    previousDayActiveSessionTiming,
    day: grouped.days.find((day) => day.date === date) ?? { date, sessions: [], totalWorkedMs: 0 },
    completedSessionToday,
    invalidSessions: grouped.invalidSessions,
  };
}

export async function getEmployeeAttendanceHistory(
  employee: EmployeeAttendanceContext,
  database: AttendanceReadDatabase = prisma,
) {
  const [sessions, shiftResolution] = await Promise.all([
    database.workSession.findMany({
      where: { record: { employeeId: employee.id } },
      orderBy: { startAt: "desc" },
    }),
    employeeShiftAssignments(employee.id, database),
  ]);
  return groupSessionsByEmployeeLocalDay(sessions, employee.timeZone, shiftResolution.assignments, employee.countryCode);
}