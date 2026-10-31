"use server";

import { revalidatePath } from "next/cache";
import { AuthenticationError, requireUser } from "@/lib/auth/session";
import { canAccessPersonalAttendance } from "@/lib/auth/permissions";
import { applyAttendanceAction, AttendanceStateError } from "@/lib/attendance/service";
import { attendanceActionSchema } from "@/lib/attendance/validation";
import { completeAttendanceAction } from "@/lib/attendance/action-completion";
import { logAttendanceActionError } from "@/lib/attendance/action-diagnostics";

export type AttendanceActionResult = { ok: true; message: string } | { ok: false; error: string };

export async function performAttendanceAction(input: unknown): Promise<AttendanceActionResult> {
  let result: Awaited<ReturnType<typeof applyAttendanceAction>>;
  try {
    const user = await requireUser();
    if (!canAccessPersonalAttendance(user.role)) {
      return { ok: false, error: "Super Administrators cannot record personal attendance." };
    }
    const parsed = attendanceActionSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: "A valid location is required before recording attendance." };
    }

    result = await applyAttendanceAction(user.id, parsed.data.action, parsed.data.location);
  } catch (error) {
    if (error instanceof AuthenticationError) return { ok: false, error: error.message };
    if (error instanceof AttendanceStateError) return { ok: false, error: error.message };
    logAttendanceActionError("attendance.submit", error);
    return { ok: false, error: "Attendance could not be updated. Try again shortly." };
  }

  return completeAttendanceAction(result.calculationWarning, () => {
    revalidatePath("/dashboard");
    revalidatePath("/attendance");
  }, (error) => logAttendanceActionError("attendance.submit_revalidation", error));
}