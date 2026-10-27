import { z } from "zod";

export const adminAttendanceExceptionCategorySchema = z.enum([
  "ALL",
  "LATE_ARRIVAL",
  "EARLY_DEPARTURE",
  "ACTIVE_SESSION",
  "NO_ATTENDANCE",
]);

export const attendanceReviewReasonSchema = z.enum([
  "ALL",
  "INVALID_IN_TIMESTAMP",
  "INVALID_OUT_TIMESTAMP",
  "OUT_BEFORE_IN",
  "UNSAFE_DURATION",
]);

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid local date.").refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Use a valid local date.");

export const adminAttendanceFilterSchema = z.object({
  employeeId: z.string().trim().optional().default(""),
  summaryDate: z.union([z.literal(""), localDateSchema]).optional().default(""),
  from: z.union([z.literal(""), localDateSchema]).optional().default(""),
  to: z.union([z.literal(""), localDateSchema]).optional().default(""),
  mode: z.enum(["ALL", "OFFICE", "WFH"]).optional().default("ALL"),
  status: z.enum(["ALL", "ACTIVE", "COMPLETED"]).optional().default("ALL"),
  exceptionCategory: adminAttendanceExceptionCategorySchema.optional().default("ALL"),
  reviewReason: attendanceReviewReasonSchema.optional().default("ALL"),
}).superRefine(({ from, to }, context) => {
  if (from && to && from > to) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "End date must be on or after start date." });
  }
});

export const adminAttendanceCorrectionSchema = z.object({
  startAt: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/, "Enter a valid employee-local start time.").optional(),
  endAt: z.union([
    z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/, "Enter a valid employee-local end time."),
    z.literal(""),
  ]).optional(),
  mode: z.enum(["OFFICE", "WFH"]).optional(),
  reason: z.string().trim().min(1, "A correction reason is required.").max(500),
}).refine((value) => value.startAt !== undefined || value.endAt !== undefined || value.mode !== undefined, {
  message: "Submit at least one correction.",
});

export type AdminAttendanceFilters = z.infer<typeof adminAttendanceFilterSchema>;
export type AdminAttendanceCorrection = z.infer<typeof adminAttendanceCorrectionSchema>;