import "server-only";

import type { Prisma, PrismaClient, Role } from "@prisma/client";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { prisma } from "@/lib/prisma";
import { getEmployeeLocalDayWindow } from "@/lib/attendance/timezone";
import { groupSessionsByEmployeeLocalDay } from "@/lib/attendance/history";
import { lockAttendanceEmployee } from "@/lib/attendance/service";
import { resolveAttendanceEmployees } from "@/lib/attendance/employee-link";
import { adminAttendanceCorrectionSchema, adminAttendanceFilterSchema, type AdminAttendanceFilters } from "@/lib/attendance/admin-validation";

type AdminActor = { id?: string; role: Role } | null;
type AdminAttendanceDatabase = Pick<PrismaClient, "user" | "employee" | "workSession">;
type AdminAttendanceWriteDatabase = AdminAttendanceDatabase & Pick<PrismaClient, "$transaction">;

export const adminEmployeeSelect = {
  id: true,
  name: true,
  email: true,
  employeeCode: true,
  countryCode: true,
  timeZone: true,
  role: true,
  isActive: true,
} as const;

export class AdminAttendanceAuthorizationError extends Error {
  constructor() {
    super("Administrator access is required.");
    this.name = "AdminAttendanceAuthorizationError";
  }
}

export class AdminAttendanceNotFoundError extends Error {
  constructor() {
    super("Attendance session not found.");
    this.name = "AdminAttendanceNotFoundError";
  }
}

export class AdminAttendanceCorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminAttendanceCorrectionError";
  }
}

function requireAdmin(admin: AdminActor): asserts admin is { role: Role } {
  if (!admin || admin.role !== "ADMIN") throw new AdminAttendanceAuthorizationError();
}

function nextLocalDay(date: string, timeZone: string) {
  const { endAt } = getEmployeeLocalDayWindow(fromZonedTime(`${date}T12:00:00.000`, timeZone), timeZone);
  return endAt;
}

function localDateTimeToInstant(value: string, timeZone: string, label: string) {
  const instant = fromZonedTime(value, timeZone);
  if (!Number.isFinite(instant.getTime()) || formatInTimeZone(instant, timeZone, "yyyy-MM-dd'T'HH:mm") !== value) {
    throw new AdminAttendanceCorrectionError(`${label} must be a valid local date and time.`);
  }
  return instant;
}

export async function listAdminAttendance(
  admin: AdminActor,
  input: unknown,
  database: AdminAttendanceDatabase = prisma,
) {
  requireAdmin(admin);
  const filters = adminAttendanceFilterSchema.parse(input);
  const employeeWhere = filters.employeeId ? { id: filters.employeeId } : {};
  const employees = await database.user.findMany({
    where: employeeWhere,
    select: adminEmployeeSelect,
    orderBy: { name: "asc" },
  });
  if (filters.employeeId && employees.length === 0) {
    return {
      employees: employees.map((employee) => ({ ...employee, employeeRecord: null })),
      sessions: [],
      dailySummaries: [],
      filters,
    };
  }
  const employeeRecords = await resolveAttendanceEmployees(employees.map(({ id }) => id), database);
  const employeesWithRecords = employees.map((employee) => ({
    ...employee,
    employeeRecord: employeeRecords.get(employee.id) ?? null,
  }));

  const dateRanges = filters.from || filters.to
    ? employeesWithRecords.map((employee) => {
        const startAt = filters.from
          ? getEmployeeLocalDayWindow(fromZonedTime(`${filters.from}T12:00:00.000`, employee.timeZone), employee.timeZone).startAt
          : undefined;
        const endAt = filters.to ? nextLocalDay(filters.to, employee.timeZone) : undefined;
        return {
          record: { employeeId: employee.id },
          ...(startAt || endAt ? { startAt: { ...(startAt ? { gte: startAt } : {}), ...(endAt ? { lt: endAt } : {}) } } : {}),
        };
      })
    : undefined;

  if (dateRanges && dateRanges.length === 0) {
    return { employees: employeesWithRecords, sessions: [], dailySummaries: [], filters };
  }

  const where: Prisma.WorkSessionWhereInput = {
    ...(filters.mode !== "ALL" ? { mode: filters.mode } : {}),
    ...(filters.status === "ACTIVE" ? { endAt: null } : filters.status === "COMPLETED" ? { endAt: { not: null } } : {}),
    ...(dateRanges ? { OR: dateRanges } : { record: { employeeId: { in: employeesWithRecords.map((employee) => employee.id) } } }),
  };

  const sessions = await database.workSession.findMany({
    where,
    include: {
      record: {
        select: { employee: { select: adminEmployeeSelect } },
      },
    },
    orderBy: { startAt: "desc" },
    take: 500,
  });
  const sessionsWithEmployeeRecords = sessions.map((session) => ({
    ...session,
    record: {
      ...session.record,
      employee: {
        ...session.record.employee,
        employeeRecord: employeeRecords.get(session.record.employee.id) ?? null,
      },
    },
  }));

  const sessionsByEmployee = new Map<string, typeof sessionsWithEmployeeRecords>();
  for (const session of sessionsWithEmployeeRecords) {
    const employeeId = session.record.employee.id;
    const employeeSessions = sessionsByEmployee.get(employeeId) ?? [];
    employeeSessions.push(session);
    sessionsByEmployee.set(employeeId, employeeSessions);
  }

  const dailySummaries = employeesWithRecords.flatMap((employee) => {
    const employeeSessions = sessionsByEmployee.get(employee.id) ?? [];
    return groupSessionsByEmployeeLocalDay(
      employeeSessions,
      employee.timeZone,
      employee.employeeRecord?.shiftAssignments ?? [],
      employee.countryCode,
    ).days.map((day) => ({ employee, day }));
  }).sort((left, right) => right.day.date.localeCompare(left.day.date) || left.employee.name.localeCompare(right.employee.name));

  return { employees: employeesWithRecords, sessions: sessionsWithEmployeeRecords, dailySummaries, filters };
}

export async function correctAdminAttendance(
  admin: AdminActor,
  sessionId: string,
  input: unknown,
  database: AdminAttendanceWriteDatabase = prisma,
) {
  requireAdmin(admin);
  const correction = adminAttendanceCorrectionSchema.parse(input);
  return database.$transaction(async (transaction) => {
    const reference = await transaction.workSession.findUnique({
      where: { id: sessionId },
      select: { record: { select: { employeeId: true } } },
    });
    if (!reference) throw new AdminAttendanceNotFoundError();

    const employeeId = reference.record.employeeId;
    await lockAttendanceEmployee(transaction, employeeId);

    const current = await transaction.workSession.findUnique({
      where: { id: sessionId },
      include: { record: { select: { employee: { select: { id: true, timeZone: true } } } } },
    });
    if (!current) throw new AdminAttendanceNotFoundError();

    const startAt = correction.startAt === undefined
      ? current.startAt
      : localDateTimeToInstant(correction.startAt, current.record.employee.timeZone, "IN time");
    const endAt = correction.endAt === undefined
      ? current.endAt
      : correction.endAt === ""
        ? null
        : localDateTimeToInstant(correction.endAt, current.record.employee.timeZone, "OUT time");

    if (endAt && endAt < startAt) {
      throw new AdminAttendanceCorrectionError("OUT time cannot be earlier than IN time.");
    }

    if (current.endAt !== null && endAt === null) {
      const existingOpenSession = await transaction.workSession.findFirst({
        where: { record: { employeeId }, endAt: null, id: { not: sessionId } },
        select: { id: true },
      });
      if (existingOpenSession) {
        throw new AdminAttendanceCorrectionError("This employee already has an open attendance session.");
      }
    }

    const oldLocalDate = formatInTimeZone(current.startAt, current.record.employee.timeZone, "yyyy-MM-dd");
    const newLocalDate = formatInTimeZone(startAt, current.record.employee.timeZone, "yyyy-MM-dd");
    if (oldLocalDate !== newLocalDate) {
      const targetDay = getEmployeeLocalDayWindow(startAt, current.record.employee.timeZone);
      const conflictingSession = await transaction.workSession.findFirst({
        where: {
          id: { not: sessionId },
          record: { employeeId },
          startAt: { gte: targetDay.startAt, lt: targetDay.endAt },
        },
        select: { id: true },
      });
      if (conflictingSession) {
        throw new AdminAttendanceCorrectionError("Another attendance session already exists on that employee-local day.");
      }
    }

    const updated = await transaction.workSession.update({
      where: { id: sessionId },
      data: {
        ...(correction.startAt !== undefined ? { startAt } : {}),
        ...(correction.endAt !== undefined ? { endAt } : {}),
        ...(correction.mode !== undefined ? { mode: correction.mode } : {}),
      },
      include: {
        record: {
          select: { employee: { select: adminEmployeeSelect } },
        },
      },
    });

    await transaction.attendanceAuditLog.create({
      data: {
        employeeId,
        sessionId,
        actorId: admin.id ?? null,
        actionType: "ADMIN_ATTENDANCE_CORRECTED",
        previousValues: { mode: current.mode, startAt: current.startAt.toISOString(), endAt: current.endAt?.toISOString() ?? null },
        newValues: { mode: updated.mode, startAt: updated.startAt.toISOString(), endAt: updated.endAt?.toISOString() ?? null },
        reason: correction.reason,
      },
      select: { id: true, employeeId: true, sessionId: true, actorId: true, actionType: true, previousValues: true, newValues: true, reason: true, createdAt: true },
    });
    return updated;
  });
}

export function parseAdminAttendanceFilters(searchParams: Record<string, string | string[] | undefined>): AdminAttendanceFilters {
  return adminAttendanceFilterSchema.parse({
    employeeId: typeof searchParams.employeeId === "string" ? searchParams.employeeId : "",
    from: typeof searchParams.from === "string" ? searchParams.from : "",
    to: typeof searchParams.to === "string" ? searchParams.to : "",
    mode: typeof searchParams.mode === "string" ? searchParams.mode : "ALL",
    status: typeof searchParams.status === "string" ? searchParams.status : "ALL",
  });
}