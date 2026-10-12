import "server-only";

import type { Prisma, PrismaClient, Role } from "@prisma/client";
import { z } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";

export const calculatedAttendanceStatuses = [
  "PRESENT",
  "LATE",
  "EARLY_OUT",
  "ABSENT",
  "LEAVE",
  "WFH",
  "MISSING_PUNCH",
  "WEEKEND",
  "HOLIDAY",
  "UNDETERMINED",
] as const;

const calendarDate = z.string().refine((value) => {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Date must be a valid calendar date.");

export const dailyAttendanceFiltersSchema = z.object({
  date: calendarDate.default(""),
  employeeId: z.string().trim().max(100).default(""),
  departmentId: z.string().trim().max(100).default(""),
  status: z.enum(["ALL", ...calculatedAttendanceStatuses]).default("ALL"),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});

export type DailyAttendanceFilters = z.infer<typeof dailyAttendanceFiltersSchema>;

type DailyAttendanceActor = { role: Role } | null;
type DailyAttendanceDatabase = Pick<PrismaClient, "attendanceDaily" | "employee" | "department">;
const pageSize = 50;

export class DailyAttendanceAuthorizationError extends Error {
  constructor() {
    super("Attendance management access is required.");
    this.name = "DailyAttendanceAuthorizationError";
  }
}

export async function listCalculatedDailyAttendance(
  actor: DailyAttendanceActor,
  input: unknown,
  database: DailyAttendanceDatabase = prisma,
) {
  if (!actor || (actor.role !== "ADMIN" && !hasPermission(actor.role, "attendance:manage"))) {
    throw new DailyAttendanceAuthorizationError();
  }
  const filters = dailyAttendanceFiltersSchema.parse(input);
  const hrEmployeeScope: Prisma.EmployeeWhereInput = actor.role === "HR_ADMINISTRATOR"
    ? { user: { is: { role: "EMPLOYEE" } } }
    : {};
  const employeeFilter: Prisma.EmployeeWhereInput = {
    ...hrEmployeeScope,
    ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
  };

  const where: Prisma.AttendanceDailyWhereInput = {
    ...(filters.date ? { date: new Date(`${filters.date}T00:00:00.000Z`) } : {}),
    ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
    ...(Object.keys(employeeFilter).length > 0 ? { employee: employeeFilter } : {}),
    ...(filters.status !== "ALL" ? { status: filters.status } : {}),
  };

  const [total, employees, departments] = await Promise.all([
    database.attendanceDaily.count({ where }),
    database.employee.findMany({
      where: hrEmployeeScope,
      select: { id: true, name: true, employeeId: true },
      orderBy: { name: "asc" },
    }),
    database.department.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(filters.page, pageCount);
  const records = await database.attendanceDaily.findMany({
    where,
    select: {
      id: true,
      date: true,
      firstIn: true,
      lastOut: true,
      workingHours: true,
      lateMinutes: true,
      earlyMinutes: true,
      overtimeHours: true,
      status: true,
      employee: {
        select: {
          id: true,
          name: true,
          employeeId: true,
          user: { select: { timeZone: true } },
          department: { select: { name: true } },
        },
      },
      shift: { select: { name: true } },
    },
    orderBy: [{ date: "desc" }, { employee: { name: "asc" } }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  return {
    records,
    employees,
    departments,
    total,
    page,
    pageCount,
    filters: { ...filters, page },
  };
}
