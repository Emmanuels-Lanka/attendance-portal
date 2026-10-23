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

export type AttendanceCorrectionState = { error: string } | { success: string } | null;

export async function correctAttendanceAction(
  sessionId: string,
  _previousState: AttendanceCorrectionState,
  formData: FormData,
): Promise<AttendanceCorrectionState> {
  try {
    const admin = await requireUser();
    await correctAdminAttendance(admin, sessionId, {
      startAt: formData.get("startAt"),
      endAt: formData.get("endAt"),
      mode: formData.get("mode"),
      reason: formData.get("reason"),
    });
    revalidatePath("/admin/attendance");
    revalidatePath("/admin/attendance/daily");
    revalidatePath("/attendance");
    return { success: "Attendance correction saved." };
  } catch (error) {
    if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? "Check the correction values." };
    if (
      error instanceof AdminAttendanceAuthorizationError
      || error instanceof AdminAttendanceCorrectionError
      || error instanceof AdminAttendanceNotFoundError
    ) {
      return { error: error.message };
    }
    console.error("Attendance correction failed", error instanceof Error ? error.name : "Unknown error");
    return { error: "The correction could not be saved. Try again shortly." };
  }
}