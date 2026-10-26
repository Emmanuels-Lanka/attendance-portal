"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import {
  decideManagerLeaveRequest,
  decideSupervisorLeaveRequest,
  LeaveApprovalAccessError,
  LeaveApprovalNotFoundError,
  LeaveApprovalScopeError,
  LeaveApprovalStageError,
} from "@/lib/leave/approval-service";
import {
  decideManagerLeaveCancellation,
  decideSupervisorLeaveCancellation,
  LeaveCancellationAccessError,
  LeaveCancellationNotFoundError,
  LeaveCancellationScopeError,
  LeaveCancellationStageError,
} from "@/lib/leave/cancellation-service";

export type LeaveDecisionState = { error: string } | { success: string } | null;

export async function decideLeaveRequestAction(
  leaveRequestId: string,
  _state: LeaveDecisionState,
  formData: FormData,
): Promise<LeaveDecisionState> {
  const actor = await requireUser();
  if (
    (actor.role !== "SUPERVISOR" && actor.role !== "DEPARTMENT_MANAGER")
    || !hasPermission(actor.role, "leave:approve")
  ) {
    throw new LeaveApprovalAccessError();
  }

  try {
    const decisionInput = {
      action: formData.get("action"),
      reason: formData.get("reason"),
    };
    const result = actor.role === "SUPERVISOR"
      ? await decideSupervisorLeaveRequest(actor, leaveRequestId, decisionInput)
      : await decideManagerLeaveRequest(actor, leaveRequestId, decisionInput);
    revalidatePath("/approvals/leave");
    revalidatePath("/dashboard");
    revalidatePath("/leave");
    revalidatePath("/leave/balance");
    return {
      success: result.currentApprovalStage === "MANAGER"
        ? "Leave request forwarded to the assigned Manager."
        : result.status === "APPROVED" ? "Leave request approved." : "Leave request rejected.",
    };
  } catch (error) {
    if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? "Check the decision." };
    if (
      error instanceof LeaveApprovalAccessError
      || error instanceof LeaveApprovalNotFoundError
      || error instanceof LeaveApprovalScopeError
      || error instanceof LeaveApprovalStageError
    ) return { error: error.message };
    console.error("Leave request decision failed", error instanceof Error ? error.name : "Unknown error");
    return { error: "The Leave decision could not be saved. Try again shortly." };
  }
}

export async function decideLeaveCancellationAction(
  leaveRequestId: string,
  _state: LeaveDecisionState,
  formData: FormData,
): Promise<LeaveDecisionState> {
  const actor = await requireUser();
  if (
    (actor.role !== "SUPERVISOR" && actor.role !== "DEPARTMENT_MANAGER")
    || !hasPermission(actor.role, "leave:approve")
  ) throw new LeaveCancellationAccessError();
  try {
    const input = { action: formData.get("action"), reason: formData.get("reason") };
    const result = actor.role === "SUPERVISOR"
      ? await decideSupervisorLeaveCancellation(actor, leaveRequestId, input)
      : await decideManagerLeaveCancellation(actor, leaveRequestId, input);
    revalidatePath("/approvals/leave");
    revalidatePath("/dashboard");
    revalidatePath("/leave");
    revalidatePath("/leave/balance");
    return {
      success: result.cancellationApprovalStage === "MANAGER"
        ? "Cancellation forwarded to the assigned Manager."
        : result.status === "CANCELLED" ? "Leave cancellation approved." : "Leave cancellation rejected.",
    };
  } catch (error) {
    if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? "Check the decision." };
    if (
      error instanceof LeaveCancellationAccessError
      || error instanceof LeaveCancellationNotFoundError
      || error instanceof LeaveCancellationScopeError
      || error instanceof LeaveCancellationStageError
    ) return { error: error.message };
    console.error("Leave cancellation decision failed", error instanceof Error ? error.name : "Unknown error");
    return { error: "The Leave cancellation decision could not be saved. Try again shortly." };
  }
}
