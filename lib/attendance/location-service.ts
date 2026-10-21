import "server-only";

import type { Prisma, PrismaClient, Role, WorkMode } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import { z } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import { getEmployeeLocalDayWindow } from "@/lib/attendance/timezone";
import { prisma } from "@/lib/prisma";
import { writeAttendanceLocationViewAudit } from "@/lib/attendance/location-audit";
import {
  parseAttendanceLocationDetails,
  type AttendanceLocationDetails,
} from "./validation";

const locationFiltersSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Select a valid attendance date."),
  employeeId: z.string().trim().max(100).default(""),
  departmentId: z.string().trim().max(100).default(""),
});

type LocationActor = { id: string; role: Role } | null;
type LocationTransaction = Pick<Prisma.TransactionClient, "employee" | "attendanceRaw" | "attendanceAuditLog" | "workSession">;
type LocationDatabase = Pick<PrismaClient, "$transaction">;

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
  workMode: WorkMode | null;
  timestamp: Date;
  timeZone: string;
  location: AttendanceLocationDetails | null;
};

export async function listAttendanceLocations(
  actor: LocationActor,
  input: unknown,
  database: LocationDatabase = prisma,
): Promise<AttendanceLocationRecord[]> {
  if (!actor || !hasPermission(actor.role, "attendance:locations:read")) {
    throw new AttendanceLocationAuthorizationError();
  }

  const filters = locationFiltersSchema.parse(input);
  return database.$transaction(async (transaction) => {
    const tx: LocationTransaction = transaction;
    const employees = await tx.employee.findMany({
      where: {
        user: { is: { role: "EMPLOYEE" } },
        ...(filters.employeeId ? { id: filters.employeeId } : {}),
        ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
      },
      select: {
        id: true,
        name: true,
        employeeId: true,
        user: { select: { id: true, timeZone: true } },
      },
    });

    let records: AttendanceLocationRecord[] = [];
    if (employees.length > 0) {
      const dateRanges = employees.flatMap((employee) => {
        const timeZone = employee.user?.timeZone;
        if (!timeZone) return [];
        const { startAt, endAt } = getEmployeeLocalDayWindow(
          fromZonedTime(`${filters.date}T12:00:00.000`, timeZone),
          timeZone,
        );
        return [{ employeeId: employee.id, timestamp: { gte: startAt, lt: endAt } }];
      });

      if (dateRanges.length > 0) {
        const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
        const punches = await tx.attendanceRaw.findMany({
          where: { OR: dateRanges },
          select: {
            id: true,
            employeeId: true,
            timestamp: true,
            punchType: true,
            workMode: true,
            location: true,
          },
          orderBy: [{ timestamp: "desc" }, { id: "asc" }],
          take: 1000,
        });

        const historicalPunches = punches.filter((punch) => punch.workMode === null);
        const inTimestamps = [...new Map(
          historicalPunches.filter((punch) => punch.punchType === "IN")
            .map(({ timestamp }) => [timestamp.getTime(), timestamp]),
        ).values()];
        const outTimestamps = [...new Map(
          historicalPunches.filter((punch) => punch.punchType === "OUT")
            .map(({ timestamp }) => [timestamp.getTime(), timestamp]),
        ).values()];
        const userIds = [...new Set(employees.map((employee) => employee.user?.id).filter((id): id is string => Boolean(id)))];
        const matchingSessions = userIds.length > 0 && (inTimestamps.length > 0 || outTimestamps.length > 0)
          ? await tx.workSession.findMany({
            where: {
              record: { is: { employeeId: { in: userIds } } },
              OR: [
                ...(inTimestamps.length > 0 ? [{ startAt: { in: inTimestamps } }] : []),
                ...(outTimestamps.length > 0 ? [{ endAt: { in: outTimestamps } }] : []),
              ],
            },
            select: {
              mode: true,
              startAt: true,
              endAt: true,
              record: { select: { employeeId: true } },
            },
          })
          : [];
        const historicalModes = new Map<string, WorkMode | null>();
        for (const punch of historicalPunches) {
          const employee = employeeById.get(punch.employeeId);
          const userId = employee?.user?.id;
          if (!userId) continue;
          const matches = matchingSessions.filter((session) =>
            session.record.employeeId === userId
            && (punch.punchType === "IN" ? session.startAt : session.endAt)?.getTime() === punch.timestamp.getTime());
          historicalModes.set(punch.id, matches.length === 1 ? matches[0].mode : null);
        }

        records = punches.flatMap((punch) => {
          const employee = employeeById.get(punch.employeeId);
          if (!employee?.user?.timeZone) return [];
          return [{
            id: punch.id,
            employeeName: employee.name,
            employeeCode: employee.employeeId,
            punchType: punch.punchType,
            workMode: punch.workMode ?? historicalModes.get(punch.id) ?? null,
            timestamp: punch.timestamp,
            timeZone: employee.user.timeZone,
            location: parseAttendanceLocationDetails(punch.location),
          }];
        });
      }
    }

    await writeAttendanceLocationViewAudit(tx, {
      actorId: actor.id,
      viewType: "ADMIN_HR",
      resultCount: records.length,
    });
    return records;
  });
}
