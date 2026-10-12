"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import {
  decideWorkFromHomeRequest,
  WorkFromHomeApprovalScopeError,
  WorkFromHomeApprovalStageError,
  WorkFromHomeApproverNotFoundError,
  WorkFromHomeRequestAccessError,
  WorkFromHomeRequestNotFoundError,
} from "@/lib/wfh/service";

export type WorkFromHomeDecisionActionState = { error: string } | { success: string } | null;

function actionError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Check the decision.";
  if (
    error instanceof WorkFromHomeApprovalScopeError
    || error instanceof WorkFromHomeApprovalStageError
    || error instanceof WorkFromHomeApproverNotFoundError
    || error instanceof WorkFromHomeRequestAccessError
    || error instanceof WorkFromHomeRequestNotFoundError
  ) return error.message;
  console.error("WFH request decision failed", error instanceof Error ? error.name : "Unknown error");
  return "The WFH decision could not be saved. Try again shortly.";
}

export async function decideWorkFromHomeRequestAction(
  requestId: string,
  _state: WorkFromHomeDecisionActionState,
  formData: FormData,
): Promise<WorkFromHomeDecisionActionState> {
  const actor = await requireUser();
  if (
    (actor.role !== "SUPERVISOR" && actor.role !== "DEPARTMENT_MANAGER")
    || !hasPermission(actor.role, "wfh:approve")
  ) {
    throw new WorkFromHomeRequestAccessError();
  }
  try {
    const result = await decideWorkFromHomeRequest(actor, requestId, {
      action: formData.get("action"),
      reason: formData.get("reason"),
    });
    revalidatePath("/approvals/wfh");
    revalidatePath("/dashboard");
    revalidatePath("/wfh");
    revalidatePath("/attendance");
    return {
      success: result.currentApprovalStage === "MANAGER"
        ? "WFH request forwarded to the assigned Manager."
        : result.status === "APPROVED" ? "WFH request approved." : "WFH request rejected.",
    };
  } catch (error) {
    return { error: actionError(error) };
  }
}
