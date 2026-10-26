import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

const supportedTimeZones = new Set(Intl.supportedValuesOf("timeZone"));
supportedTimeZones.add("UTC");

export function isIanaTimeZone(timeZone: string) {
  return supportedTimeZones.has(timeZone);
}

function nextCalendarDate(date: string) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function getEmployeeLocalDayWindow(now: Date, timeZone: string) {
  if (!isIanaTimeZone(timeZone)) {
    throw new RangeError(`Unsupported IANA timezone: ${timeZone}`);
  }

  const date = formatInTimeZone(now, timeZone, "yyyy-MM-dd");
  const nextDate = nextCalendarDate(date);

  return {
    date,
    startAt: fromZonedTime(`${date}T00:00:00.000`, timeZone),
    endAt: fromZonedTime(`${nextDate}T00:00:00.000`, timeZone),
  };
}

export function getEmployeeLocalMonthWindow(date: string, timeZone: string) {
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(parsedDate.getTime())
    || parsedDate.toISOString().slice(0, 10) !== date
  ) {
    throw new RangeError("Attendance date must be a valid YYYY-MM-DD calendar date.");
  }
  if (!isIanaTimeZone(timeZone)) {
    throw new RangeError(`Unsupported IANA timezone: ${timeZone}`);
  }

  const monthStart = `${date.slice(0, 7)}-01`;
  const nextMonth = new Date(`${monthStart}T00:00:00.000Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const nextMonthStart = nextMonth.toISOString().slice(0, 10);
  return {
    startAt: fromZonedTime(`${monthStart}T00:00:00.000`, timeZone),
    endAt: fromZonedTime(`${nextMonthStart}T00:00:00.000`, timeZone),
  };
}