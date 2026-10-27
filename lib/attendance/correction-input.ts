import { isValid } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { DailyAttendanceCorrectionInvalidValuesError } from "./correction-service";

export function attendanceCorrectionInstant(value: string, timeZone: string, attendanceDate?: string) {
  const instant = fromZonedTime(value, timeZone);
  const format = value.length === 19 ? "yyyy-MM-dd'T'HH:mm:ss" : "yyyy-MM-dd'T'HH:mm";
  if (
    !isValid(instant)
    || formatInTimeZone(instant, timeZone, format) !== value
    || (attendanceDate && formatInTimeZone(instant, timeZone, "yyyy-MM-dd") !== attendanceDate)
  ) {
    throw new DailyAttendanceCorrectionInvalidValuesError(
      attendanceDate
        ? "Enter a valid time in your configured timezone on the selected employee-local attendance date."
        : "Enter a valid local date and time in your configured timezone.",
    );
  }
  return instant.toISOString();
}
