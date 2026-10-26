import "server-only";

import type { Prisma, PrismaClient, Role } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { adminEmployeeSelect, AdminAttendanceAuthorizationError } from "@/lib/attendance/admin-service";
import { adminAttendanceFilterSchema } from "@/lib/attendance/admin-validation";
import {
  formatWorkedDuration,
  groupSessionsByEmployeeLocalDay,
  monthlyGraceAllowancesUsedBeforeEachDate,
} from "@/lib/attendance/history";
import { getEmployeeLocalDayWindow, getEmployeeLocalMonthWindow } from "@/lib/attendance/timezone";
import { resolveAttendanceEmployees } from "@/lib/attendance/employee-link";
import { isOptionalSriLankanSaturday } from "./shift-assignment";

type AdminActor = { id?: string; role: Role } | null;
type SummaryDatabase = Pick<PrismaClient, "user" | "employee" | "workSession">;

function assertAdmin(admin: AdminActor): asserts admin is Exclude<AdminActor, null> {
  if (!admin || (
    admin.role !== "ADMIN"
    && !hasPermission(admin.role, "attendance:manage")
    && !hasPermission(admin.role, "attendance:department:read")
    && !(hasPermission(admin.role, "attendance:assigned:read") && hasPermission(admin.role, "attendance:monitor"))
  )) {
    throw new AdminAttendanceAuthorizationError();
  }
}

function nextLocalDay(date: string, timeZone: string) {
  return getEmployeeLocalDayWindow(fromZonedTime(`${date}T12:00:00.000`, timeZone), timeZone).endAt;
}

export async function getAdminAttendanceSummary(
  admin: AdminActor,
  input: { date: unknown; employeeId?: string; mode?: "ALL" | "OFFICE" | "WFH" },
  database: SummaryDatabase = prisma,
) {
  assertAdmin(admin);
  const { from: date } = adminAttendanceFilterSchema.parse({ from: input.date, to: input.date });
  const employeeId = input.employeeId?.trim() ?? "";
  const mode = input.mode ?? "ALL";
  if (!date) throw new Error("Select a report date.");

  let scope: Prisma.UserWhereInput = {};
  if (admin.role === "DEPARTMENT_MANAGER") {
    const manager = await database.employee.findUnique({
      where: { userId: admin.id ?? "" },
      select: { departmentId: true },
    });
    scope = manager?.departmentId
      ? { employee: { is: { departmentId: manager.departmentId } } }
      : { id: { in: [] } };
  } else if (admin.role === "SUPERVISOR") {
    scope = {
      employee: {
        is: { supervisor: { userId: admin.id ?? "", user: { role: "SUPERVISOR", isActive: true } } },
      },
    };
  }

  const employees = await database.user.findMany({
    where: { role: "EMPLOYEE", isActive: true, ...scope, ...(employeeId ? { id: employeeId } : {}) },
    select: adminEmployeeSelect,
    orderBy: { name: "asc" },
  });
  if (employees.length === 0) {
    return {
      date,
      employees: [],
      metrics: { totalEmployees: 0, withAttendance: 0, withoutAttendance: 0, lateArrivals: 0, earlyDepartures: 0, completed: 0, activeNow: 0 },
    };
  }
  const employeeRecords = await resolveAttendanceEmployees(employees.map(({ id }) => id), database);
  const employeesWithRecords = employees.map((employee) => ({
    ...employee,
    employeeRecord: employeeRecords.get(employee.id) ?? null,
  }));
  const employeeIds = employeesWithRecords.map((employee) => employee.id);

  const localRanges = employeesWithRecords.map((employee) => {
    const { startAt } = getEmployeeLocalDayWindow(fromZonedTime(`${date}T12:00:00.000`, employee.timeZone), employee.timeZone);
    const endAt = nextLocalDay(date, employee.timeZone);
    return { record: { employeeId: employee.id }, startAt: { gte: startAt, lt: endAt } };
  });
  const policyRanges = employeesWithRecords.map((employee) => {
    const monthWindow = getEmployeeLocalMonthWindow(date, employee.timeZone);
    const endAt = nextLocalDay(date, employee.timeZone);
    return { record: { employeeId: employee.id }, startAt: { gte: monthWindow.startAt, lt: endAt } };
  });
  const modeFilter = mode === "ALL" ? {} : { mode };
  const [daySessions, openSessions, policySessions] = await Promise.all([
    database.workSession.findMany({
      where: { OR: localRanges, ...modeFilter },
      include: { record: { select: { employee: { select: adminEmployeeSelect } } } },
      orderBy: { startAt: "asc" },
    }),
    database.workSession.findMany({
      where: { endAt: null, record: { employeeId: { in: employeeIds } }, ...modeFilter },
      select: { mode: true, startAt: true, record: { select: { employeeId: true } } },
    }),
    database.workSession.findMany({
      where: { OR: policyRanges },
      select: { id: true, mode: true, startAt: true, endAt: true, record: { select: { employeeId: true } } },
      orderBy: { startAt: "asc" },
    }),
  ]);
  const daySessionsWithEmployeeRecords = daySessions.map((session) => ({
    ...session,
    record: {
      ...session.record,
      employee: {
        ...session.record.employee,
        employeeRecord: employeeRecords.get(session.record.employee.id) ?? null,
      },
    },
  }));

  const sessionsByEmployee = new Map<string, typeof daySessionsWithEmployeeRecords>();
  for (const session of daySessionsWithEmployeeRecords) {
    const id = session.record.employee.id;
    const rows = sessionsByEmployee.get(id) ?? [];
    rows.push(session);
    sessionsByEmployee.set(id, rows);
  }
  const policySessionsByEmployee = new Map<string, typeof policySessions>();
  for (const session of policySessions) {
    const id = session.record.employeeId;
    const rows = policySessionsByEmployee.get(id) ?? [];
    rows.push(session);
    policySessionsByEmployee.set(id, rows);
  }
  const activeEmployeeIds = new Set(openSessions.map((session) => session.record.employeeId));
  const summaries = employeesWithRecords.map((employee) => {
    const monthlyGraceAllowancesUsedByDate = monthlyGraceAllowancesUsedBeforeEachDate(
      policySessionsByEmployee.get(employee.id) ?? [],
      employee.timeZone,
      employee.employeeRecord?.shiftAssignments ?? [],
    );
    const grouped = groupSessionsByEmployeeLocalDay(
      sessionsByEmployee.get(employee.id) ?? [],
      employee.timeZone,
      employee.employeeRecord?.shiftAssignments ?? [],
      employee.countryCode,
      monthlyGraceAllowancesUsedByDate,
    );
    const day = grouped.days.find((entry) => entry.date === date) ?? { date, sessions: [], totalWorkedMs: 0 };
    return {
      employee,
      day,
      activeNow: activeEmployeeIds.has(employee.id),
      completedWorkedTime: formatWorkedDuration(day.totalWorkedMs),
    };
  });

  const withAttendance = summaries.filter(({ day }) => day.sessions.length > 0);
  const withoutAttendance = summaries.filter(({ employee, day }) =>
    day.sessions.length === 0 && !isOptionalSriLankanSaturday(employee.countryCode, date),
  );
  return {
    date,
    employees: summaries,
    metrics: {
      totalEmployees: summaries.length,
      withAttendance: withAttendance.length,
      withoutAttendance: withoutAttendance.length,
      lateArrivals: summaries.filter(({ day }) => day.sessions.some(({ timing }) => timing?.arrival === "LATE")).length,
      earlyDepartures: summaries.filter(({ day }) => day.sessions.some(({ timing }) => timing?.departure === "EARLY_DEPARTURE")).length,
      completed: summaries.filter(({ day }) => day.sessions.some(({ status }) => status === "COMPLETED")).length,
      activeNow: summaries.filter(({ activeNow }) => activeNow).length,
    },
  };
}