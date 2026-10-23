"use server";

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { isValid } from "date-fns";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import { requireUser, AuthorizationError } from "@/lib/auth/session";
import {
  DailyAttendanceCorrectionAccessError,
  DailyAttendanceCorrectionPendingRequestExistsError,
  DailyAttendanceCorrectionReviewerNotFoundError,
  DailyAttendanceCorrectionSubjectUserNotFoundError,
  DailyAttendanceCorrectionTargetNotFoundError,
  submitAttendanceSessionModeCorrection,
  submitDailyAttendanceCorrection,
} from "@/lib/attendance/correction-service";

export type AttendanceCorrectionSubmissionState =
  | { error: string }
  | { success: string }
  | null;

const localDateTime = z.preprocess(
  (value) => value === "" || value === null ? undefined : value,
  z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Enter a valid local date and time.").optional(),
);
const clearTime = z.preprocess((value) => value === "on", z.boolean());

const correctionFormSchema = z.object({
  dailyAttendanceId: z.string().min(1),
  firstIn: localDateTime,
  lastOut: localDateTime,
  clearFirstIn: clearTime,
  clearLastOut: clearTime,
  reason: z.string().trim().min(1, "A correction reason is required.").max(500),
}).refine(({ firstIn, lastOut, clearFirstIn, clearLastOut }) => (
  (firstIn !== undefined || lastOut !== undefined || clearFirstIn || clearLastOut)
  && !(firstIn !== undefined && clearFirstIn)
  && !(lastOut !== undefined && clearLastOut)
), {
  message: "Enter a corrected IN or OUT time, or select a time to remove. Do not enter and remove the same time.",
});
const sessionModeCorrectionFormSchema = z.object({
  sessionId: z.string().min(1),
  requestedMode: z.enum(["OFFICE", "WFH"]),
  reason: z.string().trim().min(1, "A correction reason is required.").max(500),
});

function requestedInstant(value: string, timeZone: string) {
  const instant = fromZonedTime(value, timeZone);
  if (
    !isValid(instant)
    || formatInTimeZone(instant, timeZone, "yyyy-MM-dd'T'HH:mm") !== value
  ) {
    throw new Error("Enter a valid local date and time in your configured timezone.");
  }
  return instant.toISOString();
}

function actionError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Check the correction details.";
  if (
    error instanceof DailyAttendanceCorrectionAccessError
    || error instanceof DailyAttendanceCorrectionPendingRequestExistsError
    || error instanceof DailyAttendanceCorrectionReviewerNotFoundError
    || error instanceof DailyAttendanceCorrectionSubjectUserNotFoundError
    || error instanceof DailyAttendanceCorrectionTargetNotFoundError
  ) return error.message;
  if (error instanceof Error && error.message.startsWith("Enter a valid local date and time")) return error.message;
  console.error("Attendance correction submission failed", error instanceof Error ? error.name : "Unknown error");
  return "Your attendance correction could not be submitted. Try again shortly.";
}

export async function submitAttendanceCorrectionAction(
  _state: AttendanceCorrectionSubmissionState,
  formData: FormData,
): Promise<AttendanceCorrectionSubmissionState> {
  const actor = await requireUser();
  if (actor.role !== "EMPLOYEE" || !hasPermission(actor.role, "attendance:correction:submit")) {
    throw new AuthorizationError();
  }

  try {
    const parsed = correctionFormSchema.parse({
      dailyAttendanceId: formData.get("dailyAttendanceId"),
      firstIn: formData.get("firstIn"),
      lastOut: formData.get("lastOut"),
      clearFirstIn: formData.get("clearFirstIn"),
      clearLastOut: formData.get("clearLastOut"),
      reason: formData.get("reason"),
    });
    const requestedValues = {
      ...(parsed.clearFirstIn
        ? { firstIn: null }
        : parsed.firstIn ? { firstIn: requestedInstant(parsed.firstIn, actor.timeZone) } : {}),
      ...(parsed.clearLastOut
        ? { lastOut: null }
        : parsed.lastOut ? { lastOut: requestedInstant(parsed.lastOut, actor.timeZone) } : {}),
    };
    await submitDailyAttendanceCorrection(actor, parsed.dailyAttendanceId, {
      requestedValues,
      reason: parsed.reason,
    });
    revalidatePath("/attendance/corrections");
    revalidatePath("/dashboard");
    return { success: "Your attendance correction request was submitted for review." };
  } catch (error) {
    return { error: actionError(error) };
  }
}

export async function submitAttendanceSessionModeCorrectionAction(
  _state: AttendanceCorrectionSubmissionState,
  formData: FormData,
): Promise<AttendanceCorrectionSubmissionState> {
  const actor = await requireUser();
  if (actor.role !== "EMPLOYEE" || !hasPermission(actor.role, "attendance:correction:submit")) {
    throw new AuthorizationError();
  }

  try {
    const parsed = sessionModeCorrectionFormSchema.parse({
      sessionId: formData.get("sessionId"),
      requestedMode: formData.get("requestedMode"),
      reason: formData.get("reason"),
    });
    await submitAttendanceSessionModeCorrection(actor, parsed.sessionId, {
      requestedMode: parsed.requestedMode,
      reason: parsed.reason,
    });
    revalidatePath("/attendance/corrections");
    revalidatePath("/dashboard");
    revalidatePath("/attendance");
    return { success: "Your work-mode correction request was submitted for review." };
  } catch (error) {
    return { error: actionError(error) };
  }
}
