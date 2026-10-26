import { fromZonedTime } from "date-fns-tz";
import type { AttendancePunchType, DailyAttendanceMode } from "@prisma/client";
import { getEmployeeLocalDayWindow } from "./timezone";
import { assessAttendanceArrival, assessDirector08Arrival } from "./schedule";

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
  status: "PRESENT" | "LATE" | "EARLY_OUT" | "MISSING_PUNCH" | "WEEKEND" | "HOLIDAY" | "UNDETERMINED";
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
  for (const punch of uniquePunches) {
    if (punch.punchType === "IN") {
      if (openIn) {
        punchIssues.add("UNUSUAL_SEQUENCE");
        statusReasons.add("Repeated IN before OUT; punch pairing is unresolved.");
      } else {
        openIn = punch;
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
    if (workPeriods.length > 1) {
      const previousPeriod = workPeriods.at(-2)!;
      breakPeriods.push({
        startAt: previousPeriod.endAt,
        endAt: openIn.timestamp,
        durationMs: openIn.timestamp.getTime() - previousPeriod.endAt.getTime(),
      });
    }
    openIn = null;
  }

  if (openIn) {
    punchIssues.add("MISSING_OUT");
    statusReasons.add("IN has no following OUT.");
  }

  const firstIn = uniquePunches.find((punch) => punch.punchType === "IN")?.timestamp ?? null;
  const lastOut = [...uniquePunches].reverse().find((punch) => punch.punchType === "OUT")?.timestamp ?? null;
  const hasUnresolvedSequence = [...punchIssues].some((issue) => issue === "DUPLICATE_PUNCH" || issue === "UNUSUAL_SEQUENCE");
  const totalWorkingMs = hasUnresolvedSequence ? null : workPeriods.reduce((total, period) => total + period.durationMs, 0);
  const workingHours = totalWorkingMs === null ? null : totalWorkingMs / 3_600_000;

  const scheduledEnd = endTime ? fromZonedTime(`${date}T${endTime}`, timeZone) : null;
  const arrivalAssessment = firstIn
    ? input.monthlyGraceAllowancesUsed !== undefined && startTime?.slice(0, 5) === "08:00"
      ? assessDirector08Arrival(firstIn, timeZone, shift, input.monthlyGraceAllowancesUsed)
      : assessAttendanceArrival(firstIn, timeZone, shift)
    : null;
  const earlyDuration = lastOut && scheduledEnd ? scheduledEnd.getTime() - lastOut.getTime() : null;
  const lateMinutes = arrivalAssessment?.lateMinutes ?? null;
  const earlyMinutes = earlyDuration === null
    ? null
    : earlyDuration > 0 ? minutesDifference(earlyDuration) : 0;

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
  } else if (hasUnresolvedSequence) {
    statusReasons.add("Punch sequence is unusual; a daily status cannot be assigned safely.");
  } else if (uniquePunches.length === 0 && input.holiday) {
    status = "HOLIDAY";
  } else if (uniquePunches.length === 0 && (isScheduledWorkingDay === false || input.optionalWorkday === true)) {
    status = "WEEKEND";
  } else if (uniquePunches.length > 0 && isScheduledWorkingDay === false) {
    statusReasons.add("Punches exist on a configured non-working day; the SRS does not define status or overtime treatment.");
  } else if (workPeriods.length === 0) {
    statusReasons.add("No complete work period exists; a daily status cannot be assigned safely.");
  } else if (lateMinutes === null || earlyMinutes === null) {
    statusReasons.add("Shift timing configuration is incomplete; a daily status cannot be assigned safely.");
  } else {
    const belowMinimumHours = shift.minimumWorkingHours !== null
      && workingHours !== null
      && workingHours < Number(shift.minimumWorkingHours);
    if (belowMinimumHours) {
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
    statusReasons: [...statusReasons],
    workPeriods,
    breakPeriods,
    punchIssues: [...punchIssues],
  };
}
