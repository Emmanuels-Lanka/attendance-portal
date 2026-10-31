"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AuthorizationError, requireUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import {
  DailyAttendanceCorrectionAccessError,
  DailyAttendanceCorrectionConflictError,
  DailyAttendanceCorrectionInvalidValuesError,
  DailyAttendanceCorrectionReviewerScopeError,
  DailyAttendanceCorrectionSelfApprovalError,
  DailyAttendanceCorrectionStageError,
  DailyAttendanceCorrectionTargetNotFoundError,
  decideDailyAttendanceCorrection,
} from "@/lib/attendance/correction-service";
import { measureServerOperation } from "@/lib/diagnostics/server-timing";
import { appendRefreshWarning, logServerActionError, revalidateAfterCommit } from "@/lib/diagnostics/server-action";

export type AttendanceCorrectionDecisionState = { error: string } | { success: string } | null;

export async function decideAttendanceCorrectionAction(
  correctionRequestId: string,
  _state: AttendanceCorrectionDecisionState,
  formData: FormData,
): Promise<AttendanceCorrectionDecisionState> {
  const actor = await requireUser();
  if (
    (actor.role !== "SUPERVISOR" && actor.role !== "HR_ADMINISTRATOR" && actor.role !== "DEPARTMENT_MANAGER" && actor.role !== "ADMIN")
    || !hasPermission(actor.role, "attendance:correction:approve")
  ) {
    throw new AuthorizationError();
  }
  try {
    const result = await measureServerOperation(
      "/approvals/attendance-corrections",
      "attendance.correction_decision",
      () => decideDailyAttendanceCorrection(actor, correctionRequestId, {
        action: formData.get("action"),
        reason: formData.get("reason"),
      }),
    );
    const refreshed = revalidateAfterCommit(() => {
      revalidatePath("/approvals/attendance-corrections");
      revalidatePath("/dashboard");
      revalidatePath("/attendance");
      revalidatePath("/attendance/corrections");
      revalidatePath("/admin/attendance");
      revalidatePath("/admin/attendance/daily");
      revalidatePath("/admin/reports");
      revalidatePath("/reports");
      revalidatePath("/reports/monthly");
    }, (error) => logServerActionError("attendance.correction_decision_revalidation", error, "/approvals/attendance-corrections"));
    return {
      success: appendRefreshWarning(result.status === "PENDING"
        ? "Correction advanced to HR review."
        : result.status === "APPROVED" ? "Correction approved and applied." : "Correction rejected.", refreshed),
    };
  } catch (error) {
    if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? "Check the decision." };
    if (
      error instanceof DailyAttendanceCorrectionAccessError
      || error instanceof DailyAttendanceCorrectionConflictError
      || error instanceof DailyAttendanceCorrectionInvalidValuesError
      || error instanceof DailyAttendanceCorrectionReviewerScopeError
      || error instanceof DailyAttendanceCorrectionSelfApprovalError
      || error instanceof DailyAttendanceCorrectionStageError
      || error instanceof DailyAttendanceCorrectionTargetNotFoundError
    ) return { error: error.message };
    logServerActionError("attendance.correction_decision", error, "/approvals/attendance-corrections");
    return { error: "The correction decision could not be saved. Try again shortly." };
  }
}
