import type { AttendanceShiftSchedule } from "./schedule";

export type EffectiveShiftAssignment<TShift extends AttendanceShiftSchedule & { id: string } = AttendanceShiftSchedule & { id: string }> = {
  effectiveFrom: Date | string;
  effectiveTo: Date | string | null;
  shift: TShift;
};

export type ShiftForDate<TShift extends AttendanceShiftSchedule & { id: string }> =
  | { kind: "ASSIGNED"; shift: TShift }
  | { kind: "NON_WORKING_DAY"; shift: TShift }
  | { kind: "UNCONFIGURED_WORKING_DAYS"; shift: TShift }
  | { kind: "MISSING_ASSIGNMENT" | "AMBIGUOUS" };

const weekdayNames = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;

export function isOptionalSriLankanSaturday(countryCode: string, employeeLocalDate: string) {
  if (countryCode !== "LK") return false;
  const date = new Date(`${employeeLocalDate}T00:00:00.000Z`);
  return Number.isFinite(date.getTime())
    && date.toISOString().slice(0, 10) === employeeLocalDate
    && weekdayNames[date.getUTCDay()] === "SATURDAY";
}

function dateString(value: Date | string) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

export function resolveShiftForDate<TShift extends AttendanceShiftSchedule & { id: string }>(
  assignments: readonly EffectiveShiftAssignment<TShift>[],
  date: string,
): ShiftForDate<TShift> {
  const currentAssignments = assignments.filter(({ effectiveFrom, effectiveTo }) =>
    dateString(effectiveFrom) <= date && (effectiveTo === null || dateString(effectiveTo) >= date),
  );
  if (currentAssignments.length === 0) return { kind: "MISSING_ASSIGNMENT" };
  if (currentAssignments.some(({ shift }) => !shift.workingDays?.length)) {
    return currentAssignments.length === 1
      ? { kind: "UNCONFIGURED_WORKING_DAYS", shift: currentAssignments[0].shift }
      : { kind: "AMBIGUOUS" };
  }

  const weekday = weekdayNames[new Date(`${date}T00:00:00.000Z`).getUTCDay()];
  const workingAssignments = currentAssignments.filter(({ shift }) => shift.workingDays?.includes(weekday));
  if (workingAssignments.length === 0) return { kind: "NON_WORKING_DAY", shift: currentAssignments[0].shift };
  if (workingAssignments.length > 1) return { kind: "AMBIGUOUS" };
  return { kind: "ASSIGNED", shift: workingAssignments[0].shift };
}
