"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { canSubmitOwnAttendanceCorrection } from "@/lib/auth/permissions";
import { requireUser, AuthorizationError } from "@/lib/auth/session";
import {
  DailyAttendanceCorrectionAccessError,
  DailyAttendanceCorrectionInvalidValuesError,
  DailyAttendanceCorrectionPendingRequestExistsError,
  DailyAttendanceCorrectionReviewerNotFoundError,
  DailyAttendanceCorrectionSubjectEmployeeNotFoundError,
  DailyAttendanceCorrectionSubjectUserNotFoundError,
  DailyAttendanceCorrectionTargetNotFoundError,
  submitAttendanceDateCorrection,
  submitAttendanceSessionModeCorrection,
  submitDailyAttendanceCorrection,
} from "@/lib/attendance/correction-service";
import { attendanceCorrectionInstant } from "@/lib/attendance/correction-input";
import { measureServerOperation } from "@/lib/diagnostics/server-timing";
import { appendRefreshWarning, logServerActionError, revalidateAfterCommit } from "@/lib/diagnostics/server-action";

export type AttendanceCorrectionSubmissionState =
  | { error: string }
  | { success: string }
  | null;

const localDateTime = z.preprocess(
  (value) => value === "" || value === null ? undefined : value,
  z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/, "Enter a valid local date and time.").optional(),
);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a valid attendance date.");
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

function actionError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Check the correction details.";
  if (
    error instanceof DailyAttendanceCorrectionAccessError
    || error instanceof DailyAttendanceCorrectionPendingRequestExistsError
    || error instanceof DailyAttendanceCorrectionReviewerNotFoundError
    || error instanceof DailyAttendanceCorrectionSubjectUserNotFoundError
    || error instanceof DailyAttendanceCorrectionSubjectEmployeeNotFoundError
    || error instanceof DailyAttendanceCorrectionTargetNotFoundError
    || error instanceof DailyAttendanceCorrectionInvalidValuesError
  ) return error.message;
  logServerActionError("attendance.correction_submit", error, "/attendance/corrections");
  return "Your attendance correction could not be submitted. Try again shortly.";
}

export async function submitAttendanceCorrectionAction(
  _state: AttendanceCorrectionSubmissionState,
  formData: FormData,
): Promise<AttendanceCorrectionSubmissionState> {
  const actor = await requireUser();
  if (!canSubmitOwnAttendanceCorrection(actor.role)) {
    throw new AuthorizationError();
  }

  try {
    const attendanceDateValue = formData.get("attendanceDate");
    if (attendanceDateValue !== null) {
      const parsed = z.object({
        attendanceDate: localDate,
        firstIn: localDateTime,
        lastOut: localDateTime,
        requestedMode: z.enum(["OFFICE", "WFH"]),
        reason: z.string().trim().min(1, "A correction reason is required.").max(500),
      }).parse({
        attendanceDate: attendanceDateValue,
        firstIn: formData.get("firstIn"),
        lastOut: formData.get("lastOut"),
        requestedMode: formData.get("requestedMode"),
        reason: formData.get("reason"),
      });
      const requestedValues = {
        ...(parsed.firstIn ? { firstIn: attendanceCorrectionInstant(parsed.firstIn, actor.timeZone, parsed.attendanceDate) } : {}),
        ...(parsed.lastOut ? { lastOut: attendanceCorrectionInstant(parsed.lastOut, actor.timeZone, parsed.attendanceDate) } : {}),
      };
      await measureServerOperation(
        "/attendance/corrections",
        "attendance.correction_submit_date",
        () => submitAttendanceDateCorrection(actor, {
          attendanceDate: parsed.attendanceDate,
          requestedValues,
          requestedMode: parsed.requestedMode,
          reason: parsed.reason,
        }),
      );
      const refreshed = revalidateAfterCommit(() => {
        revalidatePath("/attendance/corrections");
        revalidatePath("/approvals/attendance-corrections");
        revalidatePath("/dashboard");
      }, (error) => logServerActionError("attendance.correction_submit_date_revalidation", error, "/attendance/corrections"));
      return { success: appendRefreshWarning("Your attendance correction request was submitted for review.", refreshed) };
    }

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
        : parsed.firstIn ? { firstIn: attendanceCorrectionInstant(parsed.firstIn, actor.timeZone) } : {}),
      ...(parsed.clearLastOut
        ? { lastOut: null }
        : parsed.lastOut ? { lastOut: attendanceCorrectionInstant(parsed.lastOut, actor.timeZone) } : {}),
    };
    await measureServerOperation(
      "/attendance/corrections",
      "attendance.correction_submit_daily",
      () => submitDailyAttendanceCorrection(actor, parsed.dailyAttendanceId, {
        requestedValues,
        reason: parsed.reason,
      }),
    );
    const refreshed = revalidateAfterCommit(() => {
      revalidatePath("/attendance/corrections");
      revalidatePath("/dashboard");
    }, (error) => logServerActionError("attendance.correction_submit_daily_revalidation", error, "/attendance/corrections"));
    return { success: appendRefreshWarning("Your attendance correction request was submitted for review.", refreshed) };
  } catch (error) {
    return { error: actionError(error) };
  }
}

export async function submitAttendanceSessionModeCorrectionAction(
  _state: AttendanceCorrectionSubmissionState,
  formData: FormData,
): Promise<AttendanceCorrectionSubmissionState> {
  const actor = await requireUser();
  if (!canSubmitOwnAttendanceCorrection(actor.role)) {
    throw new AuthorizationError();
  }

  try {
    const parsed = sessionModeCorrectionFormSchema.parse({
      sessionId: formData.get("sessionId"),
      requestedMode: formData.get("requestedMode"),
      reason: formData.get("reason"),
    });
    await measureServerOperation(
      "/attendance/corrections",
      "attendance.correction_submit_session_mode",
      () => submitAttendanceSessionModeCorrection(actor, parsed.sessionId, {
        requestedMode: parsed.requestedMode,
        reason: parsed.reason,
      }),
    );
    const refreshed = revalidateAfterCommit(() => {
      revalidatePath("/attendance/corrections");
      revalidatePath("/dashboard");
      revalidatePath("/attendance");
    }, (error) => logServerActionError("attendance.correction_submit_session_mode_revalidation", error, "/attendance/corrections"));
    return { success: appendRefreshWarning("Your work-mode correction request was submitted for review.", refreshed) };
  } catch (error) {
    return { error: actionError(error) };
  }
}
