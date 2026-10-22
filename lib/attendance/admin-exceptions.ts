import "server-only";

import type { PrismaClient, Role } from "@prisma/client";
import { getAdminAttendanceSummary } from "@/lib/attendance/admin-dashboard";
import { adminAttendanceFilterSchema, type AdminAttendanceFilters } from "@/lib/attendance/admin-validation";
import { prisma } from "@/lib/prisma";
import { isOptionalSriLankanSaturday } from "./shift-assignment";

type AdminActor = { role: Role } | null;
type ExceptionsDatabase = Pick<PrismaClient, "user" | "employee" | "workSession">;
export type AttendanceExceptionCategory = Exclude<AdminAttendanceFilters["exceptionCategory"], "ALL">;

export async function getAdminAttendanceExceptions(
  admin: AdminActor,
  input: { date: unknown; employeeId?: unknown; mode?: unknown; category?: unknown },
  database: ExceptionsDatabase = prisma,
) {
  const filters = adminAttendanceFilterSchema.parse({
    summaryDate: input.date,
    employeeId: input.employeeId,
    mode: input.mode,
    exceptionCategory: input.category,
  });
  const date = filters.summaryDate;
  if (!date) throw new Error("Select a local date to view attendance exceptions.");

  const selectedModeSummary = await getAdminAttendanceSummary(admin, {
    date,
    employeeId: filters.employeeId,
    mode: filters.mode,
  }, database);
  const allModeSummary = filters.mode === "ALL"
    ? selectedModeSummary
    : await getAdminAttendanceSummary(admin, {
        date,
        employeeId: filters.employeeId,
        mode: "ALL",
      }, database);

  const employeeIds = selectedModeSummary.employees.map(({ employee }) => employee.id);
  const openSessions = employeeIds.length === 0
    ? []
    : await database.workSession.findMany({
        where: {
          endAt: null,
          record: { employeeId: { in: employeeIds } },
          ...(filters.mode !== "ALL" ? { mode: filters.mode } : {}),
        },
        select: { id: true, record: { select: { employeeId: true } } },
      });
  const openSessionCounts = new Map<string, number>();
  for (const session of openSessions) {
    const employeeId = session.record.employeeId;
    openSessionCounts.set(employeeId, (openSessionCounts.get(employeeId) ?? 0) + 1);
  }

  const allModeDays = new Map(allModeSummary.employees.map(({ employee, day }) => [employee.id, day]));
  const candidates = selectedModeSummary.employees.map(({ employee, day }) => {
    const openSessionCount = openSessionCounts.get(employee.id) ?? 0;
    const categories: AttendanceExceptionCategory[] = [];
    if (day.sessions.some(({ timing }) => timing?.arrival === "LATE")) categories.push("LATE_ARRIVAL");
    if (day.sessions.some(({ timing }) => timing?.departure === "EARLY_DEPARTURE")) categories.push("EARLY_DEPARTURE");
    if (openSessionCount > 0) categories.push("ACTIVE_SESSION");
    if (
      (allModeDays.get(employee.id)?.sessions.length ?? 0) === 0
      && !isOptionalSriLankanSaturday(employee.countryCode, date)
    ) {
      categories.push("NO_ATTENDANCE");
    }
    return { employee, day, openSessionCount, categories };
  });

  return {
    date,
    filters,
    metrics: {
      lateArrivals: candidates.filter(({ categories }) => categories.includes("LATE_ARRIVAL")).length,
      earlyDepartures: candidates.filter(({ categories }) => categories.includes("EARLY_DEPARTURE")).length,
      activeSessions: openSessions.length,
      employeesWithoutAttendance: candidates.filter(({ categories }) => categories.includes("NO_ATTENDANCE")).length,
    },
    entries: candidates.filter(({ categories }) =>
      categories.length > 0 && (filters.exceptionCategory === "ALL" || categories.includes(filters.exceptionCategory)),
    ),
  };
}