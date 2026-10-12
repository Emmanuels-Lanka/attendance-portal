"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import {
  decideSupervisorLeaveRequest,
  LeaveApprovalAccessError,
  LeaveApprovalNotFoundError,
  LeaveApprovalScopeError,
  LeaveApprovalStageError,
} from "@/lib/leave/approval-service";

export type LeaveDecisionState = { error: string } | { success: string } | null;

export async function decideLeaveRequestAction(
  leaveRequestId: string,
  _state: LeaveDecisionState,
  formData: FormData,
): Promise<LeaveDecisionState> {
  const actor = await requireUser();
  if (actor.role !== "SUPERVISOR" || !hasPermission(actor.role, "leave:approve")) {
    throw new LeaveApprovalAccessError();
  }

  try {
    const result = await decideSupervisorLeaveRequest(actor, leaveRequestId, {
      action: formData.get("action"),
      reason: formData.get("reason"),
    });
    revalidatePath("/approvals/leave");
    revalidatePath("/leave");
    revalidatePath("/leave/balance");
    return { success: result.status === "APPROVED" ? "Leave request approved." : "Leave request rejected." };
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
