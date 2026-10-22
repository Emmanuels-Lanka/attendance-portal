import { formatInTimeZone } from "date-fns-tz";
import { classifyAttendancePunch, type WorkSessionTiming } from "./schedule";
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
    return classifyAttendancePunch(punch, at, timeZone, resolution.shift);
  };
  return {
    arrival: classifyPunch(session.mode === "WFH" ? "WFH_IN" : "IN", session.startAt),
    departure: session.endAt && isValidInstant(session.endAt)
      ? classifyPunch(session.mode === "WFH" ? "WFH_OUT" : "OUT", session.endAt)
      : null,
  };
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
): AttendanceHistory {
  const byDate = new Map<string, AttendanceDay>();
  let invalidSessions = 0;

  for (const session of sessions) {
    if (!isValidInstant(session.startAt)) {
      invalidSessions += 1;
      continue;
    }

    const date = formatInTimeZone(session.startAt, timeZone, "yyyy-MM-dd");
    const classify = () => classifySessionForShiftAssignments(session, timeZone, shiftAssignments, countryCode);
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
        timing: { arrival: classifySessionForShiftAssignments(session, timeZone, shiftAssignments, countryCode).arrival, departure: null },
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