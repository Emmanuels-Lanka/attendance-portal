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
  console.error("Leave request submission failed", error instanceof Error ? error.name : "Unknown error");
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

  revalidatePath("/leave");
  redirect("/leave?success=request-submitted");
}

export async function requestLeaveCancellationAction(
  leaveRequestId: string,
  _state: LeaveRequestActionState,
  formData: FormData,
): Promise<LeaveRequestActionState> {
  const actor = await requireUser();
  try {
    const result = await requestOwnLeaveCancellation(actor, leaveRequestId, { reason: formData.get("reason") });
    revalidatePath("/leave");
    revalidatePath("/approvals/leave");
    revalidatePath("/dashboard");
    revalidatePath("/leave/balance");
    return {
      success: result.status === "CANCELLED"
        ? "Your pending Leave request was cancelled."
        : "Your cancellation was submitted. Approved leave remains active until it is approved.",
    };
  } catch (error) {
    if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? "Check the cancellation reason." };
    if (
      error instanceof LeaveCancellationAccessError
      || error instanceof LeaveCancellationNotFoundError
      || error instanceof LeaveCancellationStageError
    ) return { error: error.message };
    console.error("Leave cancellation request failed", error instanceof Error ? error.name : "Unknown error");
    return { error: "The Leave cancellation could not be submitted. Try again shortly." };
  }
}
