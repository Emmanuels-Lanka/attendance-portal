import { formatInTimeZone } from "date-fns-tz";
import { getAttendanceDataQualityReasons } from "./data-quality";
import { classifySessionForShiftAssignments } from "./history";
import type { listAdminAttendance } from "./admin-service";

type AdminAttendanceSession = Awaited<ReturnType<typeof listAdminAttendance>>["sessions"][number];

function isValidDate(value: Date) {
  return Number.isFinite(value.getTime());
}

function localDateTimeInput(value: Date, timeZone: string) {
  return isValidDate(value) ? formatInTimeZone(value, timeZone, "yyyy-MM-dd'T'HH:mm:ss") : "";
}

export function sessionView(session: AdminAttendanceSession) {
  const employee = session.record.employee;
  const startValid = isValidDate(session.startAt);
  const endValid = session.endAt === null || isValidDate(session.endAt);
  const reversed = session.endAt !== null && endValid && startValid && session.endAt < session.startAt;
  const invalid = !startValid || !endValid || reversed;
  let arrival: string | null = null;
  let departure: string | null = null;

  if (startValid) {
    const timing = classifySessionForShiftAssignments(
      session,
      employee.timeZone,
      employee.employeeRecord?.shiftAssignments ?? [],
      employee.countryCode,
      session.monthlyGraceAllowancesUsed,
    );
    arrival = timing.arrival;
    if (session.endAt && endValid && !reversed) {
      departure = timing.departure;
    }
  }

  return {
    employee,
    localDate: startValid ? formatInTimeZone(session.startAt, employee.timeZone, "yyyy-MM-dd") : "Unavailable",
    arrival,
    departure,
    invalid,
    durationMs: !invalid && session.endAt ? session.endAt.getTime() - session.startAt.getTime() : null,
    status: invalid ? "Invalid data" : session.endAt ? "Completed" : "Active",
    reviewReasons: getAttendanceDataQualityReasons(session),
    correctionStart: localDateTimeInput(session.startAt, employee.timeZone),
    correctionEnd: session.endAt && endValid ? localDateTimeInput(session.endAt, employee.timeZone) : "",
  };
}
