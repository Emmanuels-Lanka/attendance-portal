import { fromZonedTime } from "date-fns-tz";

export type LeaveShiftSchedule = {
  startTime: Date | null;
  endTime: Date | null;
  gracePeriodMinutes: number | null;
  workingDays?: readonly string[];
  breakStartTime?: Date | null;
  breakDurationMinutes?: number | null;
  minimumWorkingHours?: number | string | null;
};

export type LeaveInterval = { startAt: Date; endAt: Date };

export class LeaveScheduleConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaveScheduleConfigurationError";
  }
}

function clockMinutes(value: Date | null | undefined) {
  if (!value || !Number.isFinite(value.getTime())) return null;
  return Number(value.toISOString().slice(11, 13)) * 60 + Number(value.toISOString().slice(14, 16));
}

function instantAt(date: string, minutes: number, timeZone: string) {
  const hour = Math.floor(minutes / 60).toString().padStart(2, "0");
  const minute = (minutes % 60).toString().padStart(2, "0");
  return fromZonedTime(`${date}T${hour}:${minute}:00.000`, timeZone);
}

function scheduledBounds(shift: LeaveShiftSchedule) {
  const start = clockMinutes(shift.startTime);
  const end = clockMinutes(shift.endTime);
  if (start === null || end === null || end <= start) {
    throw new LeaveScheduleConfigurationError("The assigned shift needs valid same-day start and end times for partial leave.");
  }
  const breakMinutes = shift.breakDurationMinutes ?? 0;
  if (!Number.isSafeInteger(breakMinutes) || breakMinutes < 0 || breakMinutes >= end - start) {
    throw new LeaveScheduleConfigurationError("The assigned shift has an invalid break duration.");
  }
  return { start, end, breakMinutes };
}

export function scheduledWorkingMinutes(shift: LeaveShiftSchedule) {
  const { start, end, breakMinutes } = scheduledBounds(shift);
  return end - start - breakMinutes;
}

export function getShiftWorkIntervals(
  date: string,
  timeZone: string,
  shift: LeaveShiftSchedule,
  requireConfiguredBreak = false,
): LeaveInterval[] {
  const { start, end, breakMinutes } = scheduledBounds(shift);
  if (breakMinutes === 0) return [{ startAt: instantAt(date, start, timeZone), endAt: instantAt(date, end, timeZone) }];
  const breakStart = clockMinutes(shift.breakStartTime);
  if (breakStart === null) {
    if (requireConfiguredBreak) {
      throw new LeaveScheduleConfigurationError("An administrator must configure this shift's break start time before half-day leave can be requested.");
    }
    return [{ startAt: instantAt(date, start, timeZone), endAt: instantAt(date, end, timeZone) }];
  }
  const breakEnd = breakStart + breakMinutes;
  if (breakStart < start || breakEnd > end) {
    throw new LeaveScheduleConfigurationError("The assigned shift's break must fit inside its scheduled hours.");
  }
  return [
    ...(breakStart > start ? [{ startAt: instantAt(date, start, timeZone), endAt: instantAt(date, breakStart, timeZone) }] : []),
    ...(breakEnd < end ? [{ startAt: instantAt(date, breakEnd, timeZone), endAt: instantAt(date, end, timeZone) }] : []),
  ];
}

export function getHalfDayIntervals(
  date: string,
  timeZone: string,
  shift: LeaveShiftSchedule,
  period: "MORNING" | "AFTERNOON",
): LeaveInterval[] {
  const workingMinutes = scheduledWorkingMinutes(shift);
  if (workingMinutes % 2 !== 0) {
    throw new LeaveScheduleConfigurationError("The assigned shift's net working time cannot be split into equal whole-minute half-days.");
  }
  const midpointWorkingMinutes = workingMinutes / 2;
  const intervals = getShiftWorkIntervals(date, timeZone, shift, true);
  const before: LeaveInterval[] = [];
  const after: LeaveInterval[] = [];
  let remaining = midpointWorkingMinutes;
  for (const interval of intervals) {
    const durationMinutes = (interval.endAt.getTime() - interval.startAt.getTime()) / 60_000;
    if (remaining >= durationMinutes) {
      before.push(interval);
      remaining -= durationMinutes;
      continue;
    }
    if (remaining > 0) {
      const boundary = new Date(interval.startAt.getTime() + remaining * 60_000);
      before.push({ startAt: interval.startAt, endAt: boundary });
      after.push({ startAt: boundary, endAt: interval.endAt });
      remaining = 0;
    } else {
      after.push(interval);
    }
  }
  if (remaining !== 0) throw new LeaveScheduleConfigurationError("The assigned shift's half-day boundary could not be calculated.");
  return period === "MORNING" ? before : after;
}

export function getTimeLeaveInterval(
  date: string,
  timeZone: string,
  shift: LeaveShiftSchedule,
  startTime: string,
  endTime: string,
): LeaveInterval {
  const { start, end } = scheduledBounds(shift);
  const parse = (value: string) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
    const [hour, minute] = value.split(":").map(Number);
    return hour * 60 + minute;
  };
  const startMinute = parse(startTime);
  const endMinute = parse(endTime);
  if (startMinute === null || endMinute === null || endMinute <= startMinute || startMinute < start || endMinute > end) {
    throw new LeaveScheduleConfigurationError("Short leave times must form a valid interval within the assigned shift.");
  }
  const breakStart = clockMinutes(shift.breakStartTime);
  if ((shift.breakDurationMinutes ?? 0) > 0 && breakStart === null) {
    throw new LeaveScheduleConfigurationError("An administrator must configure this shift's break start time before short leave can be requested.");
  }
  const breakEnd = breakStart === null ? null : breakStart + (shift.breakDurationMinutes ?? 0);
  if (breakStart !== null && breakEnd !== null && startMinute < breakEnd && endMinute > breakStart) {
    throw new LeaveScheduleConfigurationError("Short leave cannot overlap the configured unpaid shift break.");
  }
  return {
    startAt: instantAt(date, startMinute, timeZone),
    endAt: instantAt(date, endMinute, timeZone),
  };
}

export function overlapMilliseconds(left: LeaveInterval, right: LeaveInterval) {
  return Math.max(0, Math.min(left.endAt.getTime(), right.endAt.getTime()) - Math.max(left.startAt.getTime(), right.startAt.getTime()));
}

export function mergedIntervals(intervals: readonly LeaveInterval[]) {
  const sorted = intervals
    .filter((interval) => interval.endAt > interval.startAt)
    .slice()
    .sort((left, right) => left.startAt.getTime() - right.startAt.getTime());
  const merged: LeaveInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.startAt > previous.endAt) {
      merged.push({ ...interval });
    } else if (interval.endAt > previous.endAt) {
      previous.endAt = interval.endAt;
    }
  }
  return merged;
}
