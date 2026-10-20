import "server-only";

import type { Prisma, PrismaClient, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeAttendanceLocationViewAudit } from "@/lib/attendance/location-audit";
import {
  parseAttendanceLocationDetails,
  type AttendanceLocationDetails,
} from "./validation";

const ownLocationLimit = 500;

type OwnLocationActor = { id: string; role: Role; timeZone: string } | null;
type OwnLocationTransaction = Pick<Prisma.TransactionClient, "employee" | "attendanceRaw" | "attendanceAuditLog">;
type OwnLocationDatabase = Pick<PrismaClient, "$transaction">;

export class OwnAttendanceLocationAuthorizationError extends Error {
  constructor() {
    super("Only employees can view their own attendance locations.");
    this.name = "OwnAttendanceLocationAuthorizationError";
  }
}

export type OwnAttendanceLocationRecord = {
  id: string;
  punchType: "IN" | "OUT";
  timestamp: Date;
  location: AttendanceLocationDetails | null;
};

export type OwnAttendanceLocationHistory = {
  employeeRecordFound: boolean;
  records: OwnAttendanceLocationRecord[];
  limitReached: boolean;
};

export async function listOwnAttendanceLocations(
  actor: OwnLocationActor,
  database: OwnLocationDatabase = prisma,
): Promise<OwnAttendanceLocationHistory> {
  if (!actor || actor.role !== "EMPLOYEE") {
    throw new OwnAttendanceLocationAuthorizationError();
  }

  return database.$transaction(async (transaction) => {
    const tx: OwnLocationTransaction = transaction;
    const employee = await tx.employee.findUnique({
      where: { userId: actor.id },
      select: { id: true },
    });
    if (!employee) {
      await writeAttendanceLocationViewAudit(tx, {
        actorId: actor.id,
        viewType: "SELF",
        resultCount: 0,
      });
      return { employeeRecordFound: false, records: [], limitReached: false };
    }

    const punches = await tx.attendanceRaw.findMany({
      where: { employeeId: employee.id },
      select: { id: true, timestamp: true, punchType: true, location: true },
      orderBy: [{ timestamp: "desc" }, { id: "asc" }],
      take: ownLocationLimit + 1,
    });
    const limitedPunches = punches.slice(0, ownLocationLimit);
    const records = limitedPunches.map((punch) => ({
      id: punch.id,
      punchType: punch.punchType,
      timestamp: punch.timestamp,
      location: parseAttendanceLocationDetails(punch.location),
    }));

    await writeAttendanceLocationViewAudit(tx, {
      actorId: actor.id,
      viewType: "SELF",
      resultCount: records.length,
    });
    return {
      employeeRecordFound: true,
      records,
      limitReached: punches.length > ownLocationLimit,
    };
  });
}
