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

type DailyAttendanceActor = { id?: string; role: Role } | null;
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
  if (!actor || (
    actor.role !== "ADMIN"
    && !hasPermission(actor.role, "attendance:manage")
    && !hasPermission(actor.role, "attendance:department:read")
    && !hasPermission(actor.role, "attendance:assigned:read")
  )) {
    throw new DailyAttendanceAuthorizationError();
  }
  if (actor.role === "SUPERVISOR" && !hasPermission(actor.role, "attendance:monitor")) {
    throw new DailyAttendanceAuthorizationError();
  }
  const filters = dailyAttendanceFiltersSchema.parse(input);
  if (
    actor.role === "SUPERVISOR"
    && filters.status === "MISSING_PUNCH"
    && !hasPermission(actor.role, "attendance:missing-punch:review")
  ) throw new DailyAttendanceAuthorizationError();
  let scopedEmployeeFilter: Prisma.EmployeeWhereInput = {};
  let scopedDepartmentFilter: Prisma.DepartmentWhereInput = {};
  if (actor.role === "HR_ADMINISTRATOR") {
    scopedEmployeeFilter = { user: { is: { role: "EMPLOYEE" } } };
  } else if (actor.role === "DEPARTMENT_MANAGER") {
    const manager = await database.employee.findUnique({
      where: { userId: actor.id ?? "" },
      select: { departmentId: true },
    });
    scopedEmployeeFilter = manager?.departmentId
      ? { departmentId: manager.departmentId, user: { is: { role: "EMPLOYEE" } } }
      : { id: { in: [] } };
    scopedDepartmentFilter = manager?.departmentId ? { id: manager.departmentId } : { id: { in: [] } };
  } else if (actor.role === "SUPERVISOR") {
    scopedEmployeeFilter = {
      supervisor: { userId: actor.id ?? "", user: { role: "SUPERVISOR", isActive: true } },
      user: { is: { role: "EMPLOYEE" } },
    };
    scopedDepartmentFilter = {
      employees: { some: scopedEmployeeFilter },
    };
  }
  const employeeConstraints = [
    scopedEmployeeFilter,
    ...(filters.departmentId ? [{ departmentId: filters.departmentId }] : []),
  ].filter((constraint) => Object.keys(constraint).length > 0);
  const employeeFilter: Prisma.EmployeeWhereInput = employeeConstraints.length > 0
    ? { AND: employeeConstraints }
    : {};

  const where: Prisma.AttendanceDailyWhereInput = {
    ...(filters.date ? { date: new Date(`${filters.date}T00:00:00.000Z`) } : {}),
    ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
    ...(Object.keys(employeeFilter).length > 0 ? { employee: employeeFilter } : {}),
    ...(filters.status !== "ALL" ? { status: filters.status } : {}),
  };

  const [total, employees, departments] = await Promise.all([
    database.attendanceDaily.count({ where }),
    database.employee.findMany({
      where: scopedEmployeeFilter,
      select: { id: true, name: true, employeeId: true },
      orderBy: { name: "asc" },
    }),
    database.department.findMany({
      where: scopedDepartmentFilter,
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
