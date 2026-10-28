import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { getEmployeeLocalDayWindow } from "./timezone";

export type AttendancePunch = "IN" | "OUT" | "WFH_IN" | "WFH_OUT";
export type WorkTimeClassification =
  | "EARLY_ARRIVAL"
  | "ON_TIME"
  | "LATE"
  | "EARLY_DEPARTURE"
  | "NORMAL"
  | "NON_WORKING_DAY"
  | "UNDETERMINED";
export type WorkSessionTiming = {
  arrival: WorkTimeClassification;
  departure: WorkTimeClassification | null;
};

export type AttendanceShiftSchedule = {
  startTime: Date | null;
  endTime: Date | null;
  gracePeriodMinutes: number | null;
  workingDays?: readonly string[];
};

const weekdayNames = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;

function timeOfDay(value: Date | null) {
  if (!value || !Number.isFinite(value.getTime())) return null;
  return value.toISOString().slice(11, 16);
}

function scheduledWorkingDay(date: string, shift: AttendanceShiftSchedule) {
  const workingDays = shift.workingDays;
  if (!workingDays?.length) return null;
  const weekday = weekdayNames[new Date(`${date}T00:00:00.000Z`).getUTCDay()];
  return workingDays.includes(weekday);
}

export function assessAttendanceArrival(
  actualAt: Date,
  timeZone: string,
  shift: AttendanceShiftSchedule | null,
) {
  if (!shift || !Number.isFinite(actualAt.getTime())) {
    return { classification: "UNDETERMINED" as const, lateMinutes: null };
  }

  const { date } = getEmployeeLocalDayWindow(actualAt, timeZone);
  const isWorkingDay = scheduledWorkingDay(date, shift);
  if (isWorkingDay === false) {
    return { classification: "NON_WORKING_DAY" as const, lateMinutes: null };
  }
  if (isWorkingDay === null) return { classification: "UNDETERMINED" as const, lateMinutes: null };

  const startTime = timeOfDay(shift.startTime);
  if (startTime === null || shift.gracePeriodMinutes === null
    || !Number.isSafeInteger(shift.gracePeriodMinutes) || shift.gracePeriodMinutes < 0) {
    return { classification: "UNDETERMINED" as const, lateMinutes: null };
  }
  const endTime = timeOfDay(shift.endTime);
  if (endTime !== null && endTime <= startTime) {
    return { classification: "UNDETERMINED" as const, lateMinutes: null };
  }

  const scheduledStart = fromZonedTime(`${date}T${startTime}:00.000`, timeZone);
  const graceEnd = scheduledStart.getTime() + shift.gracePeriodMinutes * 60_000;
  const lateDuration = actualAt.getTime() - graceEnd;
  if (actualAt < scheduledStart) {
    return { classification: "EARLY_ARRIVAL" as const, lateMinutes: 0 };
  }
  if (lateDuration <= 0) {
    return { classification: "ON_TIME" as const, lateMinutes: 0 };
  }
  return {
    classification: "LATE" as const,
    lateMinutes: Math.ceil(lateDuration / 60_000),
  };
}

export function assessDirector08Arrival(
  actualAt: Date,
  timeZone: string,
  shift: AttendanceShiftSchedule | null,
  monthlyGraceAllowancesUsed: number | null,
) {
  void monthlyGraceAllowancesUsed;
  if (!shift || !Number.isFinite(actualAt.getTime())) {
    return { classification: "UNDETERMINED" as const, lateMinutes: null, consumesGraceAllowance: false };
  }

  const { date } = getEmployeeLocalDayWindow(actualAt, timeZone);
  const isWorkingDay = scheduledWorkingDay(date, shift);
  if (isWorkingDay === false) {
    return { classification: "NON_WORKING_DAY" as const, lateMinutes: null, consumesGraceAllowance: false };
  }
  if (isWorkingDay === null || timeOfDay(shift.startTime) !== "08:00") {
    return { classification: "UNDETERMINED" as const, lateMinutes: null, consumesGraceAllowance: false };
  }

  const [hour, minute, second] = formatInTimeZone(actualAt, timeZone, "HH:mm:ss.SSS").split(":");
  const [wholeSecond, millisecond] = second.split(".");
  const timeSinceMidnight = Number(hour) * 60 * 60_000
    + Number(minute) * 60_000
    + Number(wholeSecond) * 1_000
    + Number(millisecond);
  const eightThirty = 8 * 60 * 60_000 + 30 * 60_000;
  const eightThirtyEnd = eightThirty + 60_000 - 1;

  if (timeSinceMidnight < 8 * 60 * 60_000) {
    return { classification: "EARLY_ARRIVAL" as const, lateMinutes: 0, consumesGraceAllowance: false };
  }
  if (timeSinceMidnight <= eightThirtyEnd) {
    return { classification: "ON_TIME" as const, lateMinutes: 0, consumesGraceAllowance: false };
  }
  return {
    classification: "LATE" as const,
    lateMinutes: Math.ceil((timeSinceMidnight - eightThirty) / 60_000),
    consumesGraceAllowance: false,
  };
}

export function classifyAttendancePunch(
  punch: AttendancePunch,
  actualAt: Date,
  timeZone: string,
  shift: AttendanceShiftSchedule | null,
): WorkTimeClassification {
  const isCheckIn = punch === "IN" || punch === "WFH_IN";
  if (isCheckIn) return assessAttendanceArrival(actualAt, timeZone, shift).classification;
  if (!shift || !Number.isFinite(actualAt.getTime())) return "UNDETERMINED";

  const { date } = getEmployeeLocalDayWindow(actualAt, timeZone);
  const isWorkingDay = scheduledWorkingDay(date, shift);
  if (isWorkingDay === false) return "NON_WORKING_DAY";
  if (isWorkingDay === null) return "UNDETERMINED";
  const startTime = timeOfDay(shift.startTime);
  const endTime = timeOfDay(shift.endTime);
  if (startTime === null || endTime === null || endTime <= startTime) return "UNDETERMINED";
  const boundary = fromZonedTime(`${date}T${endTime}:00.000`, timeZone);
  return actualAt < boundary ? "EARLY_DEPARTURE" : "NORMAL";
}

export function classifyWorkSession(
  session: { mode: "OFFICE" | "WFH"; startAt: Date; endAt: Date | null },
  timeZone: string,
  shift: AttendanceShiftSchedule | null,
): WorkSessionTiming {
  const checkIn = session.mode === "WFH" ? "WFH_IN" : "IN";
  const checkOut = session.mode === "WFH" ? "WFH_OUT" : "OUT";

  return {
    arrival: classifyAttendancePunch(checkIn, session.startAt, timeZone, shift),
    departure: session.endAt ? classifyAttendancePunch(checkOut, session.endAt, timeZone, shift) : null,
  };
}
