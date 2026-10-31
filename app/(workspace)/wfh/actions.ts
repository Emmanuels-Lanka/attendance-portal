"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import {
  submitOwnWorkFromHomeRequest,
  WorkFromHomeApproverNotFoundError,
  WorkFromHomeEmployeeNotFoundError,
  WorkFromHomeRequestConflictError,
  WorkFromHomeRequestAccessError,
  WorkFromHomeRequestTimeError,
} from "@/lib/wfh/service";
import { appendRefreshWarning, logServerActionError, revalidateAfterCommit } from "@/lib/diagnostics/server-action";

export type WorkFromHomeRequestActionState = { error: string } | { success: string } | null;

function actionError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Check the WFH request details.";
  if (
    error instanceof WorkFromHomeApproverNotFoundError
    || error instanceof WorkFromHomeEmployeeNotFoundError
    || error instanceof WorkFromHomeRequestConflictError
    || error instanceof WorkFromHomeRequestAccessError
    || error instanceof WorkFromHomeRequestTimeError
  ) return error.message;
  logServerActionError("wfh.request_submit", error, "/wfh");
  return "Your WFH request could not be submitted. Try again shortly.";
}

export async function submitWorkFromHomeRequestAction(
  _state: WorkFromHomeRequestActionState,
  formData: FormData,
): Promise<WorkFromHomeRequestActionState> {
  const actor = await requireUser();
  if (actor.role !== "EMPLOYEE" || !hasPermission(actor.role, "wfh:submit")) {
    throw new WorkFromHomeRequestAccessError();
  }
  try {
    await submitOwnWorkFromHomeRequest(actor, {
      date: formData.get("date"),
      startTime: formData.get("startTime"),
      endTime: formData.get("endTime"),
      reason: formData.get("reason"),
      workLocation: formData.get("workLocation"),
    });
    const refreshed = revalidateAfterCommit(() => {
      revalidatePath("/wfh");
      revalidatePath("/attendance");
      revalidatePath("/dashboard");
      revalidatePath("/approvals/wfh");
    }, (error) => logServerActionError("wfh.request_submit_revalidation", error, "/wfh"));
    return {
      success: appendRefreshWarning("Your WFH request was submitted for Supervisor review.", refreshed),
    };
  } catch (error) {
    return { error: actionError(error) };
  }
}
