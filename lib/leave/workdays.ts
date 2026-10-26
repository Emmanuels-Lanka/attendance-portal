import "server-only";

import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ShiftWeekday } from "@/lib/shifts/validation";
import { isOptionalSriLankanSaturday, resolveShiftForDate, type EffectiveShiftAssignment } from "@/lib/attendance/shift-assignment";
import type { AttendanceShiftSchedule } from "@/lib/attendance/schedule";

type LeaveWorkdayDatabase = Pick<PrismaClient, "employee">;

export type LeaveHolidayResolver = (input: {
  employeeUserId: string;
  startDate: string;
  endDate: string;
}) => Promise<ReadonlySet<string>>;

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const weekdayByUtcDay: readonly ShiftWeekday[] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

function parseDateOnly(value: string) {
  if (!dateOnlyPattern.test(value)) throw new RangeError("Leave dates must use YYYY-MM-DD format.");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new RangeError("Leave dates must be valid calendar dates.");
  }
  return date;
}

export function countScheduledWorkdays(
  startDate: string,
  endDate: string,
  workingDays: readonly ShiftWeekday[],
  holidayDates: ReadonlySet<string>,
) {
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  if (start > end) throw new RangeError("Leave end date must be on or after its start date.");

  const scheduledDays = new Set(workingDays);
  let count = 0;
  for (let timestamp = start.getTime(); timestamp <= end.getTime(); timestamp += 86_400_000) {
    const date = new Date(timestamp);
    const dateKey = date.toISOString().slice(0, 10);
    const weekday = weekdayByUtcDay[date.getUTCDay()];
    if (weekday && scheduledDays.has(weekday) && !holidayDates.has(dateKey)) count += 1;
  }
  return count;
}

export class LeaveWorkdayScheduleError extends Error {
  constructor(message = "Assign the employee to a Shift with configured working days before calculating Leave duration.") {
    super(message);
    this.name = "LeaveWorkdayScheduleError";
  }
}

export async function calculateEmployeeLeaveWorkdays(
  input: { employeeUserId: string; startDate: string; endDate: string },
  dependencies: {
    resolveHolidayDates: LeaveHolidayResolver;
    database?: LeaveWorkdayDatabase;
  },
) {
  const employee = await (dependencies.database ?? prisma).employee.findUnique({
    where: { userId: input.employeeUserId },
    select: {
      user: { select: { countryCode: true } },
      shift: { select: { id: true, startTime: true, endTime: true, gracePeriodMinutes: true, workingDays: true } },
      shiftAssignments: {
        select: {
          effectiveFrom: true,
          effectiveTo: true,
          shift: { select: { id: true, startTime: true, endTime: true, gracePeriodMinutes: true, workingDays: true } },
        },
      },
    },
  });
  if (!employee) throw new LeaveWorkdayScheduleError();
  const holidayDates = await dependencies.resolveHolidayDates(input);
  const assignments = employee.shiftAssignments?.length
    ? employee.shiftAssignments
    : employee.shift
      ? [{
          effectiveFrom: new Date("0001-01-01T00:00:00.000Z"),
          effectiveTo: null,
          shift: employee.shift,
        }]
      : [];
  if (assignments.length === 0) throw new LeaveWorkdayScheduleError();
  const effectiveAssignments = assignments as EffectiveShiftAssignment<AttendanceShiftSchedule & { id: string }>[];
  let count = 0;
  for (let timestamp = parseDateOnly(input.startDate).getTime(); timestamp <= parseDateOnly(input.endDate).getTime(); timestamp += 86_400_000) {
    const date = new Date(timestamp).toISOString().slice(0, 10);
    if (holidayDates.has(date)) continue;
    if (employee.user?.countryCode && isOptionalSriLankanSaturday(employee.user.countryCode, date)) continue;
    if (resolveShiftForDate(effectiveAssignments, date).kind === "ASSIGNED") count += 1;
  }
  return count;
}
