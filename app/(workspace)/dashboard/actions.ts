"use server";

import { revalidatePath } from "next/cache";
import { AuthenticationError, requireUser } from "@/lib/auth/session";
import { canAccessPersonalAttendance } from "@/lib/auth/permissions";
import { applyAttendanceAction, AttendanceStateError } from "@/lib/attendance/service";
import { attendanceActionSchema } from "@/lib/attendance/validation";

export type AttendanceActionResult = { ok: true; message: string } | { ok: false; error: string };

export async function performAttendanceAction(input: unknown): Promise<AttendanceActionResult> {
  try {
    const user = await requireUser();
    if (!canAccessPersonalAttendance(user.role)) {
      return { ok: false, error: "Super Administrators cannot record personal attendance." };
    }
    const parsed = attendanceActionSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: "A valid location is required before recording attendance." };
    }

    const result = await applyAttendanceAction(user.id, parsed.data.action, parsed.data.location);
    revalidatePath("/dashboard");
    revalidatePath("/attendance");
    return {
      ok: true,
      message: result.calculationWarning
        ? `Attendance updated. ${result.calculationWarning}`
        : "Attendance updated.",
    };
  } catch (error) {
    if (error instanceof AuthenticationError) return { ok: false, error: error.message };
    if (error instanceof AttendanceStateError) return { ok: false, error: error.message };
    console.error("Attendance update failed", error instanceof Error ? error.name : "Unknown error");
    return { ok: false, error: "Attendance could not be updated. Try again shortly." };
  }
}