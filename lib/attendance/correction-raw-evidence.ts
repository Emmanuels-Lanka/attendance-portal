import type { Prisma } from "@prisma/client";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { getEmployeeLocalDayWindow } from "@/lib/attendance/timezone";

type EndpointTransition = {
  label: "IN" | "OUT";
  previous: Date | null;
  next: Date | null;
};

export async function findConflictingRawPunchOnMovedEndpoint(
  transaction: Pick<Prisma.TransactionClient, "attendanceRaw">,
  employeeId: string,
  timeZone: string,
  transitions: EndpointTransition[],
) {
  for (const { label, previous, next } of transitions) {
    if (!previous || !next) continue;
    const previousDate = formatInTimeZone(previous, timeZone, "yyyy-MM-dd");
    const nextDate = formatInTimeZone(next, timeZone, "yyyy-MM-dd");
    if (previousDate === nextDate) continue;

    const day = getEmployeeLocalDayWindow(
      fromZonedTime(`${nextDate}T12:00:00.000`, timeZone),
      timeZone,
    );
    const rawPunches = await transaction.attendanceRaw.findMany({
      where: {
        employeeId,
        punchType: label,
        timestamp: { gte: day.startAt, lt: day.endAt },
      },
      select: { timestamp: true },
      take: 2,
    });
    if (
      rawPunches.length > 1
      || (rawPunches.length === 1 && rawPunches[0]!.timestamp.getTime() !== next.getTime())
    ) {
      return { label, date: nextDate };
    }
  }
  return null;
}
