import { formatInTimeZone } from "date-fns-tz";
import { assessDirector08Arrival, classifyAttendancePunch, type WorkSessionTiming } from "./schedule";
import { isOptionalSriLankanSaturday, resolveShiftForDate, type EffectiveShiftAssignment } from "./shift-assignment";

export type AttendanceSession = {
  id: string;
  mode: "OFFICE" | "WFH";
  startAt: Date;
  endAt: Date | null;
};

export type SessionSummary = {
  session: AttendanceSession;
  timing: WorkSessionTiming | null;
  durationMs: number | null;
  status: "ACTIVE" | "COMPLETED" | "INVALID";
};

export type AttendanceDay = {
  date: string;
  sessions: SessionSummary[];
  totalWorkedMs: number;
};

export type AttendanceHistory = {
  days: AttendanceDay[];
  invalidSessions: number;
};

export function classifySessionForShiftAssignments(
  session: AttendanceSession,
  timeZone: string,
  shiftAssignments: readonly EffectiveShiftAssignment[],
  countryCode = "",
  monthlyGraceAllowancesUsed?: number,
): WorkSessionTiming {
  const classifyPunch = (punch: "IN" | "OUT" | "WFH_IN" | "WFH_OUT", at: Date) => {
    const localDate = formatInTimeZone(at, timeZone, "yyyy-MM-dd");
    const resolution = resolveShiftForDate(shiftAssignments, localDate);
    if (resolution.kind === "NON_WORKING_DAY") {
      return isOptionalSriLankanSaturday(countryCode, localDate)
        ? "UNDETERMINED" as const
        : "NON_WORKING_DAY" as const;
    }
    if (resolution.kind !== "ASSIGNED") return "UNDETERMINED" as const;
    if (
      (punch === "IN" || punch === "WFH_IN")
      && resolution.shift.startTime?.toISOString().slice(11, 16) === "08:00"
    ) {
      return assessDirector08Arrival(at, timeZone, resolution.shift, monthlyGraceAllowancesUsed ?? null).classification;
    }
    return classifyAttendancePunch(punch, at, timeZone, resolution.shift);
  };
  const spansLocalDates = Boolean(
    session.endAt
    && isValidInstant(session.endAt)
    && formatInTimeZone(session.startAt, timeZone, "yyyy-MM-dd")
      !== formatInTimeZone(session.endAt, timeZone, "yyyy-MM-dd"),
  );
  return {
    arrival: classifyPunch(session.mode === "WFH" ? "WFH_IN" : "IN", session.startAt),
    departure: spansLocalDates
      ? "UNDETERMINED"
      : session.endAt && isValidInstant(session.endAt)
      ? classifyPunch(session.mode === "WFH" ? "WFH_OUT" : "OUT", session.endAt)
      : null,
  };
}

export function monthlyGraceAllowancesUsedBeforeEachDate(
  sessions: readonly AttendanceSession[],
  timeZone: string,
  shiftAssignments: readonly EffectiveShiftAssignment[],
) {
  const firstSessionByDate = new Map<string, AttendanceSession>();
  for (const session of sessions) {
    if (!isValidInstant(session.startAt)) continue;
    const date = formatInTimeZone(session.startAt, timeZone, "yyyy-MM-dd");
    const current = firstSessionByDate.get(date);
    if (!current || session.startAt < current.startAt) firstSessionByDate.set(date, session);
  }

  const allowancesByDate = new Map<string, number>();
  let currentMonth = "";
  let allowancesUsed = 0;
  for (const [date, session] of [...firstSessionByDate].sort(([left], [right]) => left.localeCompare(right))) {
    const month = date.slice(0, 7);
    if (month !== currentMonth) {
      currentMonth = month;
      allowancesUsed = 0;
    }

    const resolution = resolveShiftForDate(shiftAssignments, date);
    if (
      resolution.kind !== "ASSIGNED"
      || resolution.shift.startTime?.toISOString().slice(11, 16) !== "08:00"
    ) continue;

    allowancesByDate.set(date, allowancesUsed);
    const localTime = formatInTimeZone(session.startAt, timeZone, "HH:mm:ss.SSS");
    if (allowancesUsed < 2 && localTime > "08:30:00.000" && localTime <= "08:40:00.000") {
      allowancesUsed += 1;
    }
  }
  return allowancesByDate;
}

export function formatWorkedDuration(durationMs: number | null) {
  if (durationMs === null) return "Unavailable";
  if (durationMs > 0 && durationMs < 60_000) return `${Math.ceil(durationMs / 1_000)}s`;
  const totalMinutes = Math.floor(durationMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function isValidInstant(value: Date) {
  return Number.isFinite(value.getTime());
}

export function groupSessionsByEmployeeLocalDay(
  sessions: AttendanceSession[],
  timeZone: string,
  shiftAssignments: readonly EffectiveShiftAssignment[] = [],
  countryCode = "",
  monthlyGraceAllowancesUsedByDate?: ReadonlyMap<string, number>,
): AttendanceHistory {
  const byDate = new Map<string, AttendanceDay>();
  let invalidSessions = 0;

  for (const session of sessions) {
    if (!isValidInstant(session.startAt)) {
      invalidSessions += 1;
      continue;
    }

    const date = formatInTimeZone(session.startAt, timeZone, "yyyy-MM-dd");
    const classify = () => classifySessionForShiftAssignments(
      session,
      timeZone,
      shiftAssignments,
      countryCode,
      monthlyGraceAllowancesUsedByDate?.get(date),
    );
    let day = byDate.get(date);
    if (!day) {
      day = { date, sessions: [], totalWorkedMs: 0 };
      byDate.set(date, day);
    }

    if (!session.endAt) {
      day.sessions.push({ session, timing: classify(), durationMs: null, status: "ACTIVE" });
      continue;
    }

    if (!isValidInstant(session.endAt) || session.endAt < session.startAt) {
      day.sessions.push({
        session,
        timing: { arrival: classify().arrival, departure: null },
        durationMs: null,
        status: "INVALID",
      });
      continue;
    }

    const durationMs = session.endAt.getTime() - session.startAt.getTime();
    day.totalWorkedMs += durationMs;
    day.sessions.push({ session, timing: classify(), durationMs, status: "COMPLETED" });
  }

  return {
    days: [...byDate.values()].sort((left, right) => right.date.localeCompare(left.date)),
    invalidSessions,
  };
}