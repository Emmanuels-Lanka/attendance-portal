import "server-only";

import type { Prisma, PrismaClient, Role } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import { z } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import { getEmployeeLocalDayWindow } from "@/lib/attendance/timezone";
import { prisma } from "@/lib/prisma";
import { attendanceLocationSchema, type AttendanceLocation } from "./validation";

const locationFiltersSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Select a valid attendance date."),
  employeeId: z.string().trim().max(100).default(""),
  departmentId: z.string().trim().max(100).default(""),
});

type LocationActor = { role: Role } | null;
type LocationDatabase = Pick<PrismaClient, "employee" | "attendanceRaw">;

export class AttendanceLocationAuthorizationError extends Error {
  constructor() {
    super("Attendance location access is not authorized.");
    this.name = "AttendanceLocationAuthorizationError";
  }
}

export type AttendanceLocationRecord = {
  id: string;
  employeeName: string;
  employeeCode: string | null;
  punchType: "IN" | "OUT";
  timestamp: Date;
  timeZone: string;
  location: AttendanceLocation | null;
};

function parseLocation(value: Prisma.JsonValue | null): AttendanceLocation | null {
  const parsed = attendanceLocationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function listAttendanceLocations(
  actor: LocationActor,
  input: unknown,
  database: LocationDatabase = prisma,
): Promise<AttendanceLocationRecord[]> {
  if (!actor || !hasPermission(actor.role, "attendance:locations:read")) {
    throw new AttendanceLocationAuthorizationError();
  }

  const filters = locationFiltersSchema.parse(input);
  const employees = await database.employee.findMany({
    where: {
      user: { is: { role: "EMPLOYEE" } },
      ...(filters.employeeId ? { id: filters.employeeId } : {}),
      ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
    },
    select: {
      id: true,
      name: true,
      employeeId: true,
      user: { select: { timeZone: true } },
    },
  });
  if (employees.length === 0) return [];

  const dateRanges = employees.flatMap((employee) => {
    const timeZone = employee.user?.timeZone;
    if (!timeZone) return [];
    const { startAt, endAt } = getEmployeeLocalDayWindow(
      fromZonedTime(`${filters.date}T12:00:00.000`, timeZone),
      timeZone,
    );
    return [{ employeeId: employee.id, timestamp: { gte: startAt, lt: endAt } }];
  });
  if (dateRanges.length === 0) return [];

  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
  const punches = await database.attendanceRaw.findMany({
    where: { OR: dateRanges },
    select: {
      id: true,
      employeeId: true,
      timestamp: true,
      punchType: true,
      location: true,
    },
    orderBy: [{ timestamp: "desc" }, { id: "asc" }],
    take: 1000,
  });

  return punches.flatMap((punch) => {
    const employee = employeeById.get(punch.employeeId);
    if (!employee?.user?.timeZone) return [];
    return [{
      id: punch.id,
      employeeName: employee.name,
      employeeCode: employee.employeeId,
      punchType: punch.punchType,
      timestamp: punch.timestamp,
      timeZone: employee.user.timeZone,
      location: parseLocation(punch.location),
    }];
  });
}
