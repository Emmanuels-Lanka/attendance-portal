import type { Prisma } from "@prisma/client";

export type AttendanceLocationViewType = "SELF" | "ADMIN_HR";

export class AttendanceLocationAuditError extends Error {
  constructor() {
    super("Attendance location access could not be recorded.");
    this.name = "AttendanceLocationAuditError";
  }
}

export async function writeAttendanceLocationViewAudit(
  database: Pick<Prisma.TransactionClient, "attendanceAuditLog">,
  input: {
    actorId: string;
    viewType: AttendanceLocationViewType;
    resultCount: number;
  },
) {
  try {
    await database.attendanceAuditLog.create({
      data: {
        actorId: input.actorId,
        employeeId: null,
        actionType: "ATTENDANCE_LOCATIONS_VIEWED",
        newValues: {
          viewType: input.viewType,
          resultCount: input.resultCount,
        },
      },
      select: { id: true },
    });
  } catch {
    throw new AttendanceLocationAuditError();
  }
}
