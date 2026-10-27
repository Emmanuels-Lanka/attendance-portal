import "server-only";

import type { Prisma, PrismaClient, Role } from "@prisma/client";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { getEmployeeLocalDayWindow, getEmployeeLocalMonthWindow } from "@/lib/attendance/timezone";
import {
  groupSessionsByEmployeeLocalDay,
  monthlyGraceAllowancesUsedBeforeEachDate,
} from "@/lib/attendance/history";
import { lockAttendanceEmployee } from "@/lib/attendance/service";
import { findConflictingRawPunchOnMovedEndpoint } from "@/lib/attendance/correction-raw-evidence";
import {
  calculateAndPersistDailyAttendanceInTransaction,
  recalculateAttendanceMonthsFromDatesInTransaction,
} from "@/lib/attendance/engine-service";
import { resolveAttendanceEmployees } from "@/lib/attendance/employee-link";
import { lockEmployeeForApproval, getActiveManagerDepartmentScope, lockActiveManagerDepartmentScope } from "@/lib/organization/manager-scope";
import { adminAttendanceCorrectionSchema, adminAttendanceFilterSchema, type AdminAttendanceFilters } from "@/lib/attendance/admin-validation";

type AdminActor = { id?: string; role: Role } | null;
type AdminAttendanceReader = Pick<PrismaClient, "user" | "employee" | "workSession">;
type AdminAttendanceDatabase = AdminAttendanceReader & Pick<PrismaClient, "$transaction">;
type AdminAttendanceWriteDatabase = AdminAttendanceDatabase & Pick<PrismaClient, "$transaction" | "attendanceRaw">;

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

function requireAttendanceCorrectionAccess(actor: AdminActor): asserts actor is Exclude<AdminActor, null> {
  if (
    actor
    && Boolean(actor.id)
    && (
      actor.role === "ADMIN"
      || (actor.role === "HR_ADMINISTRATOR" && hasPermission(actor.role, "attendance:correction:manage"))
      || (actor.role === "SUPERVISOR" && hasPermission(actor.role, "attendance:correction:approve"))
      || (actor.role === "DEPARTMENT_MANAGER" && hasPermission(actor.role, "attendance:correction:manage"))
    )
  ) return;
  throw new AdminAttendanceAuthorizationError();
}

function nextLocalDay(date: string, timeZone: string) {
  const { endAt } = getEmployeeLocalDayWindow(fromZonedTime(`${date}T12:00:00.000`, timeZone), timeZone);
  return endAt;
}

function localDateTimeToInstant(value: string, timeZone: string, label: string) {
  const instant = fromZonedTime(value, timeZone);
  const format = value.length === 19 ? "yyyy-MM-dd'T'HH:mm:ss" : "yyyy-MM-dd'T'HH:mm";
  if (!Number.isFinite(instant.getTime()) || formatInTimeZone(instant, timeZone, format) !== value) {
    throw new AdminAttendanceCorrectionError(`${label} must be a valid local date and time.`);
  }
  return instant;
}

async function loadAdminAttendance(
  admin: Exclude<AdminActor, null>,
  filters: AdminAttendanceFilters,
  database: AdminAttendanceReader,
  managerScope: Awaited<ReturnType<typeof getActiveManagerDepartmentScope>>,
) {
  const employeeWhere = filters.employeeId ? { id: filters.employeeId } : {};
  const employees = await database.user.findMany({
    where: admin.role === "SUPERVISOR"
      ? { ...employeeWhere, employee: { supervisor: { userId: admin.id } } }
      : managerScope && !managerScope.isHrDepartment
        ? { ...employeeWhere, employee: { departmentId: managerScope.departmentId } }
        : employeeWhere,
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
    include: { record: { select: { employee: { select: adminEmployeeSelect } } } },
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

  const policyRanges = new Map<string, Prisma.WorkSessionWhereInput>();
  for (const session of sessionsWithEmployeeRecords) {
    const employee = session.record.employee;
    if (!Number.isFinite(session.startAt.getTime())) continue;
    const date = formatInTimeZone(session.startAt, employee.timeZone, "yyyy-MM-dd");
    const monthWindow = getEmployeeLocalMonthWindow(date, employee.timeZone);
    policyRanges.set(`${employee.id}:${date.slice(0, 7)}`, {
      record: { employeeId: employee.id },
      startAt: { gte: monthWindow.startAt, lt: monthWindow.endAt },
    });
  }
  const policySessions = policyRanges.size > 0
    ? await database.workSession.findMany({
        where: { OR: [...policyRanges.values()] },
        select: {
          id: true,
          mode: true,
          startAt: true,
          endAt: true,
          record: { select: { employeeId: true } },
        },
        orderBy: [{ startAt: "asc" }, { id: "asc" }],
      })
    : [];
  const policySessionsByEmployee = new Map<string, typeof policySessions>();
  for (const session of policySessions) {
    const employeeId = session.record.employeeId;
    const rows = policySessionsByEmployee.get(employeeId) ?? [];
    rows.push(session);
    policySessionsByEmployee.set(employeeId, rows);
  }
  const monthlyGraceAllowancesByEmployee = new Map(
    employeesWithRecords.map((employee) => [
      employee.id,
      monthlyGraceAllowancesUsedBeforeEachDate(
        policySessionsByEmployee.get(employee.id) ?? [],
        employee.timeZone,
        employee.employeeRecord?.shiftAssignments ?? [],
      ),
    ]),
  );
  const sessionsWithPolicyCounts = sessionsWithEmployeeRecords.map((session) => {
    const employee = session.record.employee;
    const date = Number.isFinite(session.startAt.getTime())
      ? formatInTimeZone(session.startAt, employee.timeZone, "yyyy-MM-dd")
      : "";
    return {
      ...session,
      monthlyGraceAllowancesUsed: monthlyGraceAllowancesByEmployee.get(employee.id)?.get(date),
    };
  });

  const sessionsByEmployee = new Map<string, typeof sessionsWithPolicyCounts>();
  for (const session of sessionsWithPolicyCounts) {
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
      monthlyGraceAllowancesByEmployee.get(employee.id),
    ).days.map((day) => ({ employee, day }));
  }).sort((left, right) => right.day.date.localeCompare(left.day.date) || left.employee.name.localeCompare(right.employee.name));

  return { employees: employeesWithRecords, sessions: sessionsWithPolicyCounts, dailySummaries, filters };
}

export async function listAdminAttendance(
  admin: AdminActor,
  input: unknown,
  database: AdminAttendanceDatabase = prisma,
) {
  requireAttendanceCorrectionAccess(admin);
  const filters = adminAttendanceFilterSchema.parse(input);
  if (admin.role === "DEPARTMENT_MANAGER") {
    return database.$transaction(async (transaction) => {
      const managerScope = await lockActiveManagerDepartmentScope(transaction, admin.id!);
      if (!managerScope) throw new AdminAttendanceAuthorizationError();
      return loadAdminAttendance(admin, filters, transaction, managerScope);
    });
  }
  return loadAdminAttendance(admin, filters, database, null);
}

export async function correctAdminAttendance(
  admin: AdminActor,
  sessionId: string,
  input: unknown,
  database: AdminAttendanceWriteDatabase = prisma,
) {
  requireAttendanceCorrectionAccess(admin);
  const correction = adminAttendanceCorrectionSchema.parse(input);
  return database.$transaction(async (transaction) => {
    const reference = await transaction.workSession.findUnique({
      where: { id: sessionId },
      select: { record: { select: { employeeId: true } } },
    });
    if (!reference) throw new AdminAttendanceNotFoundError();

    const employeeId = reference.record.employeeId;
    const managerScope = admin.role === "DEPARTMENT_MANAGER"
      ? await lockActiveManagerDepartmentScope(transaction, admin.id!)
      : null;
    if (admin.role === "DEPARTMENT_MANAGER" && !managerScope) {
      throw new AdminAttendanceAuthorizationError();
    }
    await lockAttendanceEmployee(transaction, employeeId);

    let current = await transaction.workSession.findUnique({
      where: { id: sessionId },
      include: {
        record: {
          select: {
            employee: {
              select: {
                id: true,
                timeZone: true,
                employee: { select: { id: true, departmentId: true, supervisor: { select: { userId: true } } } },
              },
            },
          },
        },
      },
    });
    if (!current) throw new AdminAttendanceNotFoundError();
    const targetEmployeeRecordId = current.record.employee.employee?.id;
    if (targetEmployeeRecordId) {
      await lockEmployeeForApproval(transaction, targetEmployeeRecordId);
      const lockedCurrent = await transaction.workSession.findUnique({
        where: { id: sessionId },
        include: {
          record: {
            select: {
              employee: {
                select: {
                  id: true,
                  timeZone: true,
                  employee: { select: { id: true, departmentId: true, supervisor: { select: { userId: true } } } },
                },
              },
            },
          },
        },
      });
      if (!lockedCurrent || lockedCurrent.record.employee.employee?.id !== targetEmployeeRecordId) {
        throw new AdminAttendanceAuthorizationError();
      }
      current = lockedCurrent;
    }
    if (current.record.employee.id === admin.id) {
      throw new AdminAttendanceCorrectionError("Submit a correction request to change your own attendance.");
    }
    if (admin.role === "SUPERVISOR" && current.record.employee.employee?.supervisor?.userId !== admin.id) {
      throw new AdminAttendanceAuthorizationError();
    }
    if (
      managerScope
      && !managerScope.isHrDepartment
      && current.record.employee.employee?.departmentId !== managerScope.departmentId
    ) {
      throw new AdminAttendanceAuthorizationError();
    }

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

    const timeZone = current.record.employee.timeZone;
    const endpointDates = (session: { startAt: Date; endAt: Date | null }) => [
      formatInTimeZone(session.startAt, timeZone, "yyyy-MM-dd"),
      ...(session.endAt ? [formatInTimeZone(session.endAt, timeZone, "yyyy-MM-dd")] : []),
    ];
    const updatedEndpoints = { startAt, endAt };
    const oldStartDate = endpointDates(current)[0];
    const newStartDate = endpointDates(updatedEndpoints)[0];
    const datesToRecalculate = [...new Set([
      ...endpointDates(current),
      ...endpointDates(updatedEndpoints),
    ])].sort();
    const rawPunchConflict = targetEmployeeRecordId
      ? await findConflictingRawPunchOnMovedEndpoint(transaction, targetEmployeeRecordId, timeZone, [
          { label: "IN", previous: current.startAt, next: startAt },
          { label: "OUT", previous: current.endAt, next: endAt },
        ])
      : null;
    if (rawPunchConflict) {
      throw new AdminAttendanceCorrectionError(
        `A different raw ${rawPunchConflict.label} punch already exists on the corrected employee-local date ${rawPunchConflict.date}. Review the punch evidence before changing the endpoint.`,
      );
    }

    const changed = await transaction.workSession.updateMany({
      where: {
        id: sessionId,
        mode: current.mode,
        startAt: current.startAt,
        endAt: current.endAt,
        ...(managerScope && !managerScope.isHrDepartment
          ? { record: { employee: { employee: { departmentId: managerScope.departmentId } } } }
          : {}),
      },
      data: {
        ...(correction.startAt !== undefined ? { startAt } : {}),
        ...(correction.endAt !== undefined ? { endAt } : {}),
        ...(correction.mode !== undefined ? { mode: correction.mode } : {}),
      },
    });
    if (changed.count !== 1) {
      throw new AdminAttendanceCorrectionError("This session changed while the correction was being saved. Refresh and try again.");
    }
    const updated = await transaction.workSession.findUnique({
      where: { id: sessionId },
      include: {
        record: { select: { employee: { select: adminEmployeeSelect } } },
      },
    });
    if (!updated) throw new AdminAttendanceNotFoundError();

    await transaction.attendanceAuditLog.create({
      data: {
        employeeId,
        sessionId,
        actorId: admin.id ?? null,
        actionType: "ATTENDANCE_DIRECTLY_CORRECTED",
        previousValues: { mode: current.mode, startAt: current.startAt.toISOString(), endAt: current.endAt?.toISOString() ?? null },
        newValues: { mode: updated.mode, startAt: updated.startAt.toISOString(), endAt: updated.endAt?.toISOString() ?? null, actorRole: admin.role },
        reason: correction.reason,
      },
      select: { id: true, employeeId: true, sessionId: true, actorId: true, actionType: true, previousValues: true, newValues: true, reason: true, createdAt: true },
    });
    if (targetEmployeeRecordId) {
      const startChanged = startAt.getTime() !== current.startAt.getTime();
      if (startChanged) {
        await recalculateAttendanceMonthsFromDatesInTransaction(transaction, {
          employeeRecordId: targetEmployeeRecordId,
          employeeUserId: employeeId,
          timeZone,
          affectedDates: [oldStartDate, newStartDate],
        });
      }
      const startChangeMonths = startChanged
        ? new Set([oldStartDate.slice(0, 7), newStartDate.slice(0, 7)])
        : new Set<string>();
      for (const date of datesToRecalculate) {
        if (startChangeMonths.has(date.slice(0, 7))) continue;
        await calculateAndPersistDailyAttendanceInTransaction(transaction, targetEmployeeRecordId, date);
      }
    }
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