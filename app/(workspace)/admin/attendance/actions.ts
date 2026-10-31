"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import {
  AdminAttendanceAuthorizationError,
  AdminAttendanceCorrectionError,
  AdminAttendanceNotFoundError,
  correctAdminAttendance,
} from "@/lib/attendance/admin-service";
import { measureServerOperation } from "@/lib/diagnostics/server-timing";
import { appendRefreshWarning, logServerActionError, revalidateAfterCommit } from "@/lib/diagnostics/server-action";

export type AttendanceCorrectionState = { error: string } | { success: string } | null;

export async function correctAttendanceAction(
  sessionId: string,
  _previousState: AttendanceCorrectionState,
  formData: FormData,
): Promise<AttendanceCorrectionState> {
  try {
    const admin = await requireUser();
    await measureServerOperation("admin.attendance", "attendance.direct_correction", () => (
      correctAdminAttendance(admin, sessionId, {
        startAt: formData.get("startAt"),
        endAt: formData.get("endAt"),
        mode: formData.get("mode"),
        reason: formData.get("reason"),
      })
    ));
    const refreshed = revalidateAfterCommit(() => {
      revalidatePath("/admin/attendance");
      revalidatePath("/admin/attendance/daily");
      revalidatePath("/attendance");
      revalidatePath("/reports");
      revalidatePath("/reports/monthly");
      revalidatePath("/admin/reports");
    }, (error) => logServerActionError("attendance.direct_correction_revalidation", error, "/admin/attendance"));
    return { success: appendRefreshWarning("Attendance correction saved.", refreshed) };
  } catch (error) {
    if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? "Check the correction values." };
    if (
      error instanceof AdminAttendanceAuthorizationError
      || error instanceof AdminAttendanceCorrectionError
      || error instanceof AdminAttendanceNotFoundError
    ) {
      return { error: error.message };
    }
    logServerActionError("attendance.direct_correction", error, "/admin/attendance");
    return { error: "The correction could not be saved. Try again shortly." };
  }
}