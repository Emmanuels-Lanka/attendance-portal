"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import {
  decideOvertimeRequest,
  OvertimeApprovalScopeError,
  OvertimeApprovalStageError,
  OvertimeApproverNotFoundError,
  OvertimeRequestAccessError,
  OvertimeRequestNotFoundError,
} from "@/lib/overtime/service";
import { appendRefreshWarning, logServerActionError, revalidateAfterCommit } from "@/lib/diagnostics/server-action";

export type OvertimeDecisionActionState = { error: string } | { success: string } | null;

function actionError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Check the decision.";
  if (
    error instanceof OvertimeApprovalScopeError
    || error instanceof OvertimeApprovalStageError
    || error instanceof OvertimeApproverNotFoundError
    || error instanceof OvertimeRequestAccessError
    || error instanceof OvertimeRequestNotFoundError
  ) return error.message;
  logServerActionError("overtime.request_decision", error, "/approvals/overtime");
  return "The overtime decision could not be saved. Try again shortly.";
}

export async function decideOvertimeRequestAction(
  overtimeRequestId: string,
  _state: OvertimeDecisionActionState,
  formData: FormData,
): Promise<OvertimeDecisionActionState> {
  const actor = await requireUser();
  if (
    (actor.role !== "SUPERVISOR" && actor.role !== "DEPARTMENT_MANAGER")
    || !hasPermission(actor.role, "overtime:approve")
  ) {
    throw new OvertimeRequestAccessError();
  }
  try {
    const result = await decideOvertimeRequest(actor, overtimeRequestId, {
      action: formData.get("action"),
      reason: formData.get("reason"),
    });
    const refreshed = revalidateAfterCommit(() => {
      revalidatePath("/approvals/overtime");
      revalidatePath("/dashboard");
      revalidatePath("/overtime");
    }, (error) => logServerActionError("overtime.request_decision_revalidation", error, "/approvals/overtime"));
    return {
      success: appendRefreshWarning(result.currentApprovalStage === "MANAGER"
        ? "Overtime request forwarded to the assigned Manager."
        : result.status === "APPROVED" ? "Overtime request approved." : "Overtime request rejected.", refreshed),
    };
  } catch (error) {
    return { error: actionError(error) };
  }
}
