"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import {
  LeaveRequestAttachmentNotFoundError,
  LeaveRequestEmployeeNotFoundError,
  LeaveRequestLeaveTypeNotFoundError,
  LeaveRequestOverlapError,
  LeaveRequestScheduleError,
  submitOwnLeaveRequest,
} from "@/lib/leave/request-service";
import {
  LeaveCancellationAccessError,
  LeaveCancellationNotFoundError,
  LeaveCancellationStageError,
  requestOwnLeaveCancellation,
} from "@/lib/leave/cancellation-service";
import { leaveRequestSubmissionRedirect } from "@/lib/leave/submission-feedback";
import { appendRefreshWarning, logServerActionError, revalidateAfterCommit } from "@/lib/diagnostics/server-action";

export type LeaveRequestActionState = { error: string } | { success: string } | null;

function actionError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Check the Leave request details.";
  if (
    error instanceof LeaveRequestAttachmentNotFoundError
    || error instanceof LeaveRequestEmployeeNotFoundError
    || error instanceof LeaveRequestLeaveTypeNotFoundError
    || error instanceof LeaveRequestOverlapError
    || error instanceof LeaveRequestScheduleError
  ) return error.message;
  logServerActionError("leave.request_submit", error, "/leave");
  return "Your Leave request could not be submitted. Try again shortly.";
}

export async function submitLeaveRequestAction(
  _state: LeaveRequestActionState,
  formData: FormData,
): Promise<LeaveRequestActionState> {
  const actor = await requireUser();
  try {
    await submitOwnLeaveRequest(actor, {
      leaveTypeId: formData.get("leaveTypeId"),
      startDate: formData.get("startDate") ?? formData.get("leaveDate"),
      endDate: formData.get("endDate") ?? formData.get("leaveDate"),
      startTime: formData.get("startTime"),
      endTime: formData.get("endTime"),
      halfDayPeriod: formData.get("halfDayPeriod"),
      reason: formData.get("reason"),
      attachmentDocumentId: formData.get("attachmentDocumentId"),
    });
  } catch (error) {
    return { error: actionError(error) };
  }

  const refreshed = revalidateAfterCommit(() => revalidatePath("/leave"),
    (error) => logServerActionError("leave.request_submit_revalidation", error, "/leave"));
  redirect(leaveRequestSubmissionRedirect(refreshed));
}

export async function requestLeaveCancellationAction(
  leaveRequestId: string,
  _state: LeaveRequestActionState,
  formData: FormData,
): Promise<LeaveRequestActionState> {
  const actor = await requireUser();
  try {
    const result = await requestOwnLeaveCancellation(actor, leaveRequestId, { reason: formData.get("reason") });
    const refreshed = revalidateAfterCommit(() => {
      revalidatePath("/leave");
      revalidatePath("/approvals/leave");
      revalidatePath("/dashboard");
      revalidatePath("/leave/balance");
    }, (error) => logServerActionError("leave.cancellation_submit_revalidation", error, "/leave"));
    return {
      success: appendRefreshWarning(result.status === "CANCELLED"
        ? "Your pending Leave request was cancelled."
        : "Your cancellation was submitted. Approved leave remains active until it is approved.", refreshed),
    };
  } catch (error) {
    if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? "Check the cancellation reason." };
    if (
      error instanceof LeaveCancellationAccessError
      || error instanceof LeaveCancellationNotFoundError
      || error instanceof LeaveCancellationStageError
    ) return { error: error.message };
    logServerActionError("leave.cancellation_submit", error, "/leave");
    return { error: "The Leave cancellation could not be submitted. Try again shortly." };
  }
}
