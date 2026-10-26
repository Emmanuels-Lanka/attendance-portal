import { z } from "zod";
import { organizationIdSchema, organizationListQuerySchema, organizationNameSchema } from "@/lib/organization/validation";

export const shiftWeekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
export type ShiftWeekday = (typeof shiftWeekdays)[number];

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const nullableTimeSchema = z.preprocess((value) => {
  if (value === "" || value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return value;
  return new Date(`1970-01-01T${value}:00.000Z`);
}, z.date().nullable());

const nullableIntegerSchema = z.preprocess((value) => {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value === "string") return Number(value);
  return value;
}, z.number().int().min(-2147483648).max(2147483647).nullable());

const nullableWorkingHoursSchema = z.preprocess((value) => {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value === "string" && /^-?\d+(?:\.\d{1,2})?$/.test(value)) return Number(value);
  if (typeof value === "string") return Number.NaN;
  return value;
}, z.number().finite().min(-999999.99).max(999999.99).refine(
  (value) => Number(value.toFixed(2)) === value,
  "Minimum working hours can have at most two decimal places.",
).nullable());

const nullableBooleanSchema = z.preprocess((value) => {
  if (value === "" || value === null || value === undefined) return null;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean().nullable());

const nullableJsonSchema = z.preprocess((value) => value ?? "", z.string()).transform((value, context): JsonValue | null => {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Rounding rules must be valid JSON." });
    return z.NEVER;
  }
});

export const shiftRecordSchema = z.object({
  name: organizationNameSchema,
  startTime: nullableTimeSchema.default(null),
  endTime: nullableTimeSchema.default(null),
  breakStartTime: nullableTimeSchema.default(null),
  breakDurationMinutes: nullableIntegerSchema.default(null),
  gracePeriodMinutes: nullableIntegerSchema.default(null),
  lateThresholdMinutes: nullableIntegerSchema.default(null),
  earlyDepartureThresholdMinutes: nullableIntegerSchema.default(null),
  minimumWorkingHours: nullableWorkingHoursSchema.default(null),
  overtimeEligible: nullableBooleanSchema.default(null),
  roundingRules: nullableJsonSchema.default(null),
  workingDays: z.array(z.enum(shiftWeekdays)).max(7).default([]).refine(
    (days) => new Set(days).size === days.length,
    "Select each working day only once.",
  ),
}).refine((shift) => {
  if (!shift.breakStartTime) return true;
  if (!shift.startTime || !shift.endTime || !shift.breakDurationMinutes || shift.breakDurationMinutes < 0) return false;
  const start = shift.startTime.getTime();
  const end = shift.endTime.getTime();
  const breakStart = shift.breakStartTime.getTime();
  return end > start && breakStart >= start && breakStart + shift.breakDurationMinutes * 60_000 <= end;
}, {
  path: ["breakStartTime"],
  message: "Break start and duration must fit within the configured shift.",
});
export const shiftIdSchema = organizationIdSchema;
export { organizationListQuerySchema as shiftListQuerySchema };
