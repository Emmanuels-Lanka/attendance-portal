"use server";

import { revalidatePath } from "next/cache";
import { AuthenticationError, requireUser } from "@/lib/auth/session";
import { applyAttendanceAction, AttendanceStateError } from "@/lib/attendance/service";
import { attendanceActionSchema } from "@/lib/attendance/validation";

export type AttendanceActionResult = { ok: true; message: string } | { ok: false; error: string };

export async function performAttendanceAction(input: unknown): Promise<AttendanceActionResult> {
  try {
    const user = await requireUser();
    const parsed = attendanceActionSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: "A valid location is required before recording attendance." };
    }

    await applyAttendanceAction(user.id, parsed.data.action, parsed.data.location);
    revalidatePath("/dashboard");
    revalidatePath("/attendance");
    return { ok: true, message: "Attendance updated." };
  } catch (error) {
    if (error instanceof AuthenticationError) return { ok: false, error: error.message };
    if (error instanceof AttendanceStateError) return { ok: false, error: error.message };
    console.error("Attendance update failed", error instanceof Error ? error.name : "Unknown error");
    return { ok: false, error: "Attendance could not be updated. Try again shortly." };
  }
}