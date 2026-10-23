import { formatInTimeZone } from "date-fns-tz";
import { isIanaTimeZone } from "@/lib/attendance/timezone";

export const CORRECTION_DISPLAY_FALLBACK_TIME_ZONE = "UTC";

export function correctionDisplayTimeZone(timeZone: string | null | undefined) {
  return timeZone && isIanaTimeZone(timeZone) ? timeZone : CORRECTION_DISPLAY_FALLBACK_TIME_ZONE;
}

export function formatCorrectionTimestamp(value: Date | string | null | undefined, timeZone?: string | null) {
  if (value === null || value === undefined) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const zone = correctionDisplayTimeZone(timeZone);
  return `${formatInTimeZone(date, zone, "yyyy-MM-dd HH:mm:ss XXX")} (${zone})`;
}

export function formatCorrectionCalendarDate(value: Date, timeZone?: string | null) {
  return formatInTimeZone(value, correctionDisplayTimeZone(timeZone), "yyyy-MM-dd");
}

function isTimestampField(fieldName: string | undefined) {
  return fieldName !== undefined
    && (fieldName.endsWith("At") || fieldName.endsWith("Timestamp") || fieldName === "firstIn" || fieldName === "lastOut");
}

function formatJsonValue(value: unknown, timeZone: string, fieldName?: string): unknown {
  if (typeof value === "string") {
    if (
      isTimestampField(fieldName)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ) {
      return formatCorrectionTimestamp(value, timeZone);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => formatJsonValue(item, timeZone, fieldName));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, formatJsonValue(item, timeZone, key)]),
    );
  }
  return value;
}

export function formatCorrectionJsonForDisplay(value: unknown, timeZone?: string | null) {
  if (value === null || value === undefined) return "—";
  return JSON.stringify(formatJsonValue(value, correctionDisplayTimeZone(timeZone)), null, 2);
}
