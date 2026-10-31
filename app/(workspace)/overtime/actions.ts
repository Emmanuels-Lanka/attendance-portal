"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import {
  OvertimeApproverNotFoundError,
  OvertimeEmployeeNotFoundError,
  OvertimeRequestAccessError,
  OvertimeRequestTimeError,
  submitOwnOvertimeRequest,
} from "@/lib/overtime/service";
import { appendRefreshWarning, logServerActionError, revalidateAfterCommit } from "@/lib/diagnostics/server-action";

export type OvertimeRequestActionState = { error: string } | { success: string } | null;

function actionError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Check the overtime request details.";
  if (
    error instanceof OvertimeRequestAccessError
    || error instanceof OvertimeApproverNotFoundError
    || error instanceof OvertimeEmployeeNotFoundError
    || error instanceof OvertimeRequestTimeError
  ) return error.message;
  logServerActionError("overtime.request_submit", error, "/overtime");
  return "Your overtime request could not be submitted. Try again shortly.";
}

export async function submitOvertimeRequestAction(
  _state: OvertimeRequestActionState,
  formData: FormData,
): Promise<OvertimeRequestActionState> {
  const actor = await requireUser();
  if (actor.role !== "EMPLOYEE" || !hasPermission(actor.role, "overtime:submit")) {
    throw new OvertimeRequestAccessError();
  }
  try {
    await submitOwnOvertimeRequest(actor, {
      date: formData.get("date"),
      startTime: formData.get("startTime"),
      endTime: formData.get("endTime"),
      reason: formData.get("reason"),
      project: formData.get("project"),
      expectedHours: formData.get("expectedHours"),
    });
    const refreshed = revalidateAfterCommit(() => {
      revalidatePath("/overtime");
      revalidatePath("/dashboard");
    }, (error) => logServerActionError("overtime.request_submit_revalidation", error, "/overtime"));
    return {
      success: appendRefreshWarning("Your overtime request was submitted for Supervisor review.", refreshed),
    };
  } catch (error) {
    return { error: actionError(error) };
  }
}
