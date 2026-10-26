import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { AttendancePunchType, DailyAttendanceMode } from "@prisma/client";
import { getEmployeeLocalDayWindow } from "./timezone";
import { assessAttendanceArrival, assessDirector08Arrival } from "./schedule";
import {
  getHalfDayIntervals,
  getShiftWorkIntervals,
  getTimeLeaveInterval,
  mergedIntervals,
  overlapMilliseconds,
  scheduledWorkingMinutes,
  type LeaveInterval,
} from "@/lib/leave/periods";

export type RawAttendancePunch = {
  id: string;
  timestamp: Date;
  punchType: AttendancePunchType;
};

export type DailyAttendanceCorrectionValues = Partial<{
  firstIn: Date | null;
  lastOut: Date | null;
}>;

export type AttendanceEngineShift = {
  id: string;
  startTime: Date | null;
  endTime: Date | null;
  breakStartTime?: Date | null;
  gracePeriodMinutes: number | null;
  lateThresholdMinutes: number | null;
  earlyDepartureThresholdMinutes: number | null;
  breakDurationMinutes: number | null;
  minimumWorkingHours: number | string | null;
  overtimeEligible: boolean | null;
  roundingRules: unknown;
  workingDays?: readonly string[];
};

export type AttendanceEngineResult = {
  employeeId: string;
  date: string;
  mode: DailyAttendanceMode | null;
  shiftId: string | null;
  firstIn: Date | null;
  lastOut: Date | null;
  workingHours: number | null;
  lateMinutes: number | null;
  earlyMinutes: number | null;
  status: "PRESENT" | "LATE" | "EARLY_OUT" | "MISSING_PUNCH" | "WEEKEND" | "HOLIDAY" | "LEAVE" | "INVALID" | "UNDETERMINED";
  leaveMinutes: number;
  statusReasons: string[];
  workPeriods: Array<{ startAt: Date; endAt: Date; durationMs: number }>;
  breakPeriods: Array<{ startAt: Date; endAt: Date; durationMs: number }>;
  punchIssues: Array<"MISSING_IN" | "MISSING_OUT" | "DUPLICATE_PUNCH" | "UNUSUAL_SEQUENCE">;
};

export class AttendanceEngineConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendanceEngineConfigurationError";
  }
}

function validInstant(value: Date) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function timeOfDay(value: Date) {
  if (!validInstant(value)) throw new AttendanceEngineConfigurationError("Shift start and end times must be valid.");
  return value.toISOString().slice(11, 19);
}

function minutesDifference(durationMs: number) {
  if (durationMs % 60_000 !== 0) return null;
  return durationMs / 60_000;
}

export function attendanceDailyWorkingHoursForStorage(workingHours: number | null) {
  if (workingHours === null || !Number.isFinite(workingHours)) return null;
  const hundredths = workingHours * 100;
  return Math.abs(hundredths - Math.round(hundredths)) <= Number.EPSILON * Math.max(1, Math.abs(hundredths))
    ? workingHours
    : null;
}

export function calculateDailyAttendance(input: {
  employeeId: string;
  date: string;
  timeZone: string;
  mode?: DailyAttendanceMode | null;
  shift: AttendanceEngineShift | null;
  punches: readonly RawAttendancePunch[];
  correction?: DailyAttendanceCorrectionValues;
  monthlyGraceAllowancesUsed?: number;
  holiday?: boolean;
  optionalWorkday?: boolean;
  approvedLeavePeriods?: readonly {
    durationMode: "FULL_DAY" | "HALF_DAY" | "TIME_BASED";
    startTime: Date | null;
    endTime: Date | null;
    halfDayPeriod: "MORNING" | "AFTERNOON" | null;
  }[];
}): AttendanceEngineResult {
  const { employeeId, date, timeZone, shift } = input;
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new AttendanceEngineConfigurationError("Attendance date must be a valid YYYY-MM-DD calendar date.");
  }
  const localDay = getEmployeeLocalDayWindow(fromZonedTime(`${date}T12:00:00.000`, timeZone), timeZone);
  if (!shift) {
    if (input.optionalWorkday && input.punches.length === 0 && !input.correction) {
      return {
        employeeId,
        date,
        mode: input.mode ?? null,
        shiftId: null,
        firstIn: null,
        lastOut: null,
        workingHours: null,
        lateMinutes: null,
        earlyMinutes: null,
        status: input.holiday ? "HOLIDAY" : "WEEKEND",
        leaveMinutes: 0,
        statusReasons: [
          input.holiday
            ? "No applicable Shift or raw punches exist on an organization-wide holiday."
            : "This employee-local workday is optional and has no applicable Shift or raw punches.",
        ],
        workPeriods: [],
        breakPeriods: [],
        punchIssues: [],
      };
    }
    throw new AttendanceEngineConfigurationError("An applicable Shift is required to calculate attendance.");
  }
  const weekdayNames = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;
  const weekday = weekdayNames[parsedDate.getUTCDay()];
  const isScheduledWorkingDay = shift.workingDays?.length ? shift.workingDays.includes(weekday) : null;
  if (
    (shift.gracePeriodMinutes !== null && (!Number.isSafeInteger(shift.gracePeriodMinutes) || shift.gracePeriodMinutes < 0))
    || (shift.lateThresholdMinutes !== null && (!Number.isSafeInteger(shift.lateThresholdMinutes) || shift.lateThresholdMinutes < 0))
    || (shift.earlyDepartureThresholdMinutes !== null && (!Number.isSafeInteger(shift.earlyDepartureThresholdMinutes) || shift.earlyDepartureThresholdMinutes < 0))
  ) {
    throw new AttendanceEngineConfigurationError("Shift attendance thresholds must be non-negative whole minutes.");
  }
  const startTime = shift.startTime ? timeOfDay(shift.startTime) : null;
  const endTime = shift.endTime ? timeOfDay(shift.endTime) : null;
  const overnightShift = startTime !== null && endTime !== null && endTime <= startTime;
  if (overnightShift) {
    throw new AttendanceEngineConfigurationError(
      "The SRS does not define overnight Shift calculation; this Shift cannot be calculated safely.",
    );
  }

  let approvedFullDayLeave = false;
  let approvedMorningHalfDayLeave = false;
  const leaveIntervals: LeaveInterval[] = [];
  try {
    for (const leave of input.approvedLeavePeriods ?? []) {
      if (leave.durationMode === "FULL_DAY") {
        approvedFullDayLeave = true;
        leaveIntervals.push(...getShiftWorkIntervals(date, timeZone, shift));
      } else if (leave.durationMode === "HALF_DAY") {
        if (!leave.halfDayPeriod) {
          throw new AttendanceEngineConfigurationError("Approved half-day leave has no configured period.");
        }
        approvedMorningHalfDayLeave ||= leave.halfDayPeriod === "MORNING";
        leaveIntervals.push(...getHalfDayIntervals(date, timeZone, shift, leave.halfDayPeriod));
      } else {
        if (!leave.startTime || !leave.endTime) {
          throw new AttendanceEngineConfigurationError("Approved time-based leave has no approved start and end times.");
        }
        leaveIntervals.push(...[
          getTimeLeaveInterval(
            date,
            timeZone,
            shift,
            leave.startTime.toISOString().slice(11, 16),
            leave.endTime.toISOString().slice(11, 16),
          ),
        ]);
      }
    }
  } catch (error) {
    if (error instanceof AttendanceEngineConfigurationError) throw error;
    if (error instanceof Error) throw new AttendanceEngineConfigurationError(error.message);
    throw error;
  }
  const approvedIntervals = mergedIntervals(leaveIntervals);
  const scheduledMinutes = approvedIntervals.length > 0 ? scheduledWorkingMinutes(shift) : 0;
  const leaveMinutes = Math.min(
    scheduledMinutes,
    Math.round(approvedIntervals.reduce((sum, interval) => sum + (interval.endAt.getTime() - interval.startAt.getTime()), 0) / 60_000),
  );

  let punches = input.punches
    .filter((punch) => validInstant(punch.timestamp)
      && punch.timestamp >= localDay.startAt
      && punch.timestamp < localDay.endAt)
    .slice()
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime() || left.id.localeCompare(right.id));

  if (input.correction) {
    for (const correctedTime of [input.correction.firstIn, input.correction.lastOut]) {
      if (
        correctedTime !== undefined
        && correctedTime !== null
        && (!validInstant(correctedTime) || correctedTime < localDay.startAt || correctedTime >= localDay.endAt)
      ) {
        throw new AttendanceEngineConfigurationError("Corrected attendance punches must remain within the employee-local attendance day.");
      }
    }

    const correctEndpoint = (
      punchType: AttendancePunchType,
      timestamp: Date | null | undefined,
      endpoint: "firstIn" | "lastOut",
    ) => {
      if (timestamp === undefined) return;
      const matchingIndexes = punches.flatMap((punch, index) => punch.punchType === punchType ? [index] : []);
      const index = endpoint === "firstIn" ? matchingIndexes[0] : matchingIndexes.at(-1);
      if (index === undefined) {
        if (timestamp) punches.push({ id: `correction:${endpoint}`, timestamp, punchType });
      } else if (timestamp === null) {
        punches.splice(index, 1);
      } else {
        punches[index] = { ...punches[index], timestamp };
      }
    };

    correctEndpoint("IN", input.correction.firstIn, "firstIn");
    correctEndpoint("OUT", input.correction.lastOut, "lastOut");
    punches = punches.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime() || left.id.localeCompare(right.id));
  }

  const punchIssues = new Set<AttendanceEngineResult["punchIssues"][number]>();
  const statusReasons = new Set<string>();
  const uniquePunches: RawAttendancePunch[] = [];
  for (const punch of punches) {
    const previous = uniquePunches.at(-1);
    if (previous && previous.punchType === punch.punchType) {
      if (previous.timestamp.getTime() === punch.timestamp.getTime()) {
        punchIssues.add("DUPLICATE_PUNCH");
        statusReasons.add("Duplicate raw punch; punch interpretation is unresolved.");
      } else {
        punchIssues.add("UNUSUAL_SEQUENCE");
        statusReasons.add("Repeated punch direction; punch interpretation is unresolved.");
      }
    }
    uniquePunches.push(punch);
  }

  const workPeriods: AttendanceEngineResult["workPeriods"] = [];
  const breakPeriods: AttendanceEngineResult["breakPeriods"] = [];
  let openIn: RawAttendancePunch | null = null;
  let previousOut: Date | null = null;
  for (const punch of uniquePunches) {
    if (punch.punchType === "IN") {
      if (openIn) {
        punchIssues.add("UNUSUAL_SEQUENCE");
        statusReasons.add("Repeated IN before OUT; punch pairing is unresolved.");
      } else {
        if (previousOut && punch.timestamp > previousOut) {
          breakPeriods.push({
            startAt: previousOut,
            endAt: punch.timestamp,
            durationMs: punch.timestamp.getTime() - previousOut.getTime(),
          });
        }
        openIn = punch;
        previousOut = null;
      }
      continue;
    }

    if (!openIn) {
      punchIssues.add("MISSING_IN");
      statusReasons.add("OUT has no preceding IN.");
      continue;
    }

    const durationMs = punch.timestamp.getTime() - openIn.timestamp.getTime();
    workPeriods.push({ startAt: openIn.timestamp, endAt: punch.timestamp, durationMs });
    openIn = null;
    previousOut = punch.timestamp;
  }

  if (openIn) {
    punchIssues.add("MISSING_OUT");
    statusReasons.add("IN has no following OUT.");
  }

  const firstIn = uniquePunches.find((punch) => punch.punchType === "IN")?.timestamp ?? null;
  const lastOut = [...uniquePunches].reverse().find((punch) => punch.punchType === "OUT")?.timestamp ?? null;
  const hasUnresolvedSequence = [...punchIssues].some((issue) => issue === "DUPLICATE_PUNCH" || issue === "UNUSUAL_SEQUENCE");
  const rawWorkingMs = workPeriods.reduce((total, period) => total + period.durationMs, 0);
  const configuredBreakFallbackMs = breakPeriods.length === 0
    ? (shift.breakDurationMinutes ?? 0) * 60_000
    : 0;
  const totalWorkingMs = hasUnresolvedSequence
    ? null
    : Math.max(0, rawWorkingMs - configuredBreakFallbackMs);
  const workingHours = totalWorkingMs === null ? null : totalWorkingMs / 3_600_000;

  const scheduledEnd = endTime ? fromZonedTime(`${date}T${endTime}`, timeZone) : null;
  const arrivalAssessment = firstIn
    ? startTime?.slice(0, 5) === "08:00"
      ? assessDirector08Arrival(firstIn, timeZone, shift, input.monthlyGraceAllowancesUsed ?? null)
      : assessAttendanceArrival(firstIn, timeZone, shift)
    : null;
  const localArrivalTime = firstIn ? formatInTimeZone(firstIn, timeZone, "HH:mm:ss.SSS") : null;
  let lateMinutes = arrivalAssessment?.lateMinutes ?? null;
  if (firstIn && startTime?.slice(0, 5) === "08:00" && localArrivalTime) {
    const graceBoundary = localArrivalTime <= "08:30:00.000" ? null
      : localArrivalTime <= "09:30:00.000" ? fromZonedTime(`${date}T08:30:00`, timeZone)
        : fromZonedTime(`${date}T09:30:00`, timeZone);
    if (graceBoundary) {
      const arrivalWindow = { startAt: graceBoundary, endAt: firstIn };
      const fullLateMinutes = Math.ceil((firstIn.getTime() - graceBoundary.getTime()) / 60_000);
      const excusedMs = approvedIntervals.reduce((sum, leave) => sum + overlapMilliseconds(leave, arrivalWindow), 0);
      const remainingMs = Math.max(0, firstIn.getTime() - graceBoundary.getTime() - excusedMs);
      if (localArrivalTime > "08:40:00.000" && localArrivalTime <= "09:30:00.000") {
        lateMinutes = excusedMs === 0 ? null
          : remainingMs === 0 ? 0
          : remainingMs > 0 ? Math.ceil(remainingMs / 60_000) : null;
      } else if (localArrivalTime > "09:30:00.000") {
        lateMinutes = Math.ceil(remainingMs / 60_000);
      } else if (lateMinutes !== null) {
        lateMinutes = Math.max(0, lateMinutes - Math.ceil(excusedMs / 60_000));
      } else if (excusedMs > 0 && remainingMs === 0) {
        lateMinutes = 0;
      }
      if (fullLateMinutes > 0 && excusedMs > 0) {
        statusReasons.add("Approved leave excuses only its overlap with late scheduled time.");
      }
    }
  }
  const earlyDuration = lastOut && scheduledEnd ? scheduledEnd.getTime() - lastOut.getTime() : null;
  const earlyExcusedMs = earlyDuration !== null && earlyDuration > 0 && lastOut && scheduledEnd
    ? approvedIntervals.reduce((sum, leave) => sum + overlapMilliseconds(leave, { startAt: lastOut, endAt: scheduledEnd }), 0)
    : 0;
  const earlyMinutes = earlyDuration === null
    ? null
    : earlyDuration > 0 ? minutesDifference(Math.max(0, earlyDuration - earlyExcusedMs)) : 0;
  const invalidLateArrival = localArrivalTime !== null
    && localArrivalTime > "09:45:00.000"
    && startTime?.slice(0, 5) === "08:00"
    && !approvedFullDayLeave
    && !approvedMorningHalfDayLeave;

  if (earlyDuration !== null && earlyMinutes === null) {
    statusReasons.add("Early duration is below whole-minute precision and cannot be stored without rounding.");
  }
  if (totalWorkingMs !== null && (totalWorkingMs * 100) % 3_600_000 !== 0) {
    statusReasons.add("Working hours exceed the Phase A two-decimal storage precision; no rounding was applied.");
  }
  if (!shift.startTime) statusReasons.add("Shift start time is not configured; arrival status is unresolved.");
  if (shift.gracePeriodMinutes === null) statusReasons.add("Grace period is not configured; arrival status is unresolved.");
  if (!shift.endTime) statusReasons.add("Shift end time is not configured; departure status is unresolved.");
  if (shift.minimumWorkingHours === null) statusReasons.add("Minimum working hours are not configured; a normal day cannot be distinguished from a Half Day.");
  statusReasons.add("Configured grace and shift end determine Late and Early Out; the late threshold does not delay the Late classification.");
  if (arrivalAssessment && arrivalAssessment.lateMinutes !== null && arrivalAssessment.lateMinutes > 0) {
    statusReasons.add("Late minutes round any positive fraction of a minute up; lateness classification uses the exact grace boundary.");
  }
  if (localArrivalTime !== null && localArrivalTime > "08:40:00.000" && localArrivalTime <= "09:30:00.000" && leaveMinutes === 0) {
    statusReasons.add("Arrival in this window requires approved short leave; pending or absent leave does not excuse attendance.");
  }
  if (invalidLateArrival) {
    statusReasons.add("Arrival after 09:45 requires approved morning half-day leave.");
  }
  if (approvedIntervals.length > 0) {
    statusReasons.add("Approved leave excuses only its scheduled-time overlap; actual punch timestamps and worked hours are preserved.");
  }
  if (breakPeriods.length === 0 && (shift.breakDurationMinutes ?? 0) > 0) {
    statusReasons.add("Configured unpaid break was subtracted once because no explicit break punch pair exists.");
  }
  if (workPeriods.length === 0 && uniquePunches.length === 0) {
    statusReasons.add(input.holiday
      ? "No raw punches exist on an organization-wide holiday."
      : isScheduledWorkingDay === false
        ? "No raw punches exist on a configured non-working day."
        : "No raw punches exist for this employee-local date; absence cannot be distinguished from leave, WFH, holiday, or a non-working day.");
  }
  if (hasUnresolvedSequence) statusReasons.add("Punch sequence is unusual; work-period calculation is unresolved.");

  const incomplete = punchIssues.has("MISSING_IN") || punchIssues.has("MISSING_OUT");
  let status: AttendanceEngineResult["status"] = "UNDETERMINED";
  if (incomplete) {
    status = "MISSING_PUNCH";
  } else if (invalidLateArrival) {
    status = "INVALID";
  } else if (hasUnresolvedSequence) {
    statusReasons.add("Punch sequence is unusual; a daily status cannot be assigned safely.");
  } else if (uniquePunches.length === 0 && input.holiday) {
    status = "HOLIDAY";
  } else if (uniquePunches.length === 0 && (isScheduledWorkingDay === false || input.optionalWorkday === true)) {
    status = "WEEKEND";
  } else if (uniquePunches.length === 0 && approvedFullDayLeave) {
    status = "LEAVE";
  } else if (uniquePunches.length > 0 && isScheduledWorkingDay === false) {
    statusReasons.add("Punches exist on a configured non-working day; the SRS does not define status or overtime treatment.");
  } else if (workPeriods.length === 0) {
    statusReasons.add("No complete work period exists; a daily status cannot be assigned safely.");
  } else if (lateMinutes === null || earlyMinutes === null) {
    statusReasons.add("Shift timing configuration is incomplete; a daily status cannot be assigned safely.");
  } else {
    if (approvedFullDayLeave && workingHours === 0 && leaveMinutes >= scheduledMinutes) {
      status = "LEAVE";
    }
    const requiredWorkingHours = shift.minimumWorkingHours === null
      ? null
      : Math.max(0, Number(shift.minimumWorkingHours) - leaveMinutes / 60);
    const belowMinimumHours = requiredWorkingHours !== null
      && workingHours !== null
      && workingHours < requiredWorkingHours;
    if (status === "LEAVE") {
      statusReasons.add("Approved full-day leave covers the scheduled work time.");
    } else if (belowMinimumHours) {
      statusReasons.add("Worked hours are below the configured minimum; approval is unavailable to distinguish a Half Day.");
    } else if (lateMinutes > 0 && earlyMinutes > 0) {
      statusReasons.add("The SRS does not define precedence when both Late and Early Out apply.");
    } else if (lateMinutes > 0) {
      status = "LATE";
    } else if (earlyMinutes > 0) {
      status = "EARLY_OUT";
    } else if (shift.minimumWorkingHours === null) {
      statusReasons.add("Minimum working hours are unset; status cannot be distinguished from a Half Day.");
    } else if (workingHours === null) {
      statusReasons.add("Working hours are unresolved; a daily status cannot be assigned safely.");
    } else {
      status = "PRESENT";
    }
  }

  return {
    employeeId,
    date,
    mode: input.mode ?? null,
    shiftId: shift.id,
    firstIn,
    lastOut,
    workingHours,
    lateMinutes,
    earlyMinutes,
    status,
    leaveMinutes,
    statusReasons: [...statusReasons],
    workPeriods,
    breakPeriods,
    punchIssues: [...punchIssues],
  };
}
