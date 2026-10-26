"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { createShift, deleteShift, getChangedShiftFields, getShift, ShiftAccessError, ShiftInUseError, ShiftNotFoundError, updateShift, writeShiftAuditEvent } from "@/lib/shifts/service";

export type ShiftActionState = { error: string } | null;

function actionError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Enter a valid Shift name.";
  if (error instanceof ShiftAccessError || error instanceof ShiftInUseError || error instanceof ShiftNotFoundError) return error.message;
  console.error("Shift management action failed", error instanceof Error ? error.name : "Unknown error");
  return "The Shift could not be saved. Try again shortly.";
}

export async function saveShiftAction(
  id: string | null,
  _state: ShiftActionState,
  formData: FormData,
): Promise<ShiftActionState> {
  try {
    const admin = await requirePermission("shift:manage");
    const formValues = {
      name: formData.get("name"),
      startTime: formData.get("startTime"),
      endTime: formData.get("endTime"),
      breakStartTime: formData.get("breakStartTime"),
      breakDurationMinutes: formData.get("breakDurationMinutes"),
      gracePeriodMinutes: formData.get("gracePeriodMinutes"),
      lateThresholdMinutes: formData.get("lateThresholdMinutes"),
      earlyDepartureThresholdMinutes: formData.get("earlyDepartureThresholdMinutes"),
      minimumWorkingHours: formData.get("minimumWorkingHours"),
      overtimeEligible: formData.get("overtimeEligible"),
      roundingRules: formData.get("roundingRules"),
      workingDays: formData.getAll("workingDays"),
    };
    await prisma.$transaction(async (tx) => {
      if (id) {
        const before = await getShift(admin, id, tx);
        const updated = await updateShift(admin, id, formValues, tx);
        const changedFields = getChangedShiftFields(before, updated);
        if (changedFields.length > 0) {
          await writeShiftAuditEvent(tx, { shiftId: id, actorId: admin.id, operation: "UPDATED", changedFields });
        }
      } else {
        const created = await createShift(admin, formValues, tx);
        await writeShiftAuditEvent(tx, {
          shiftId: created.id,
          actorId: admin.id,
          operation: "CREATED",
          changedFields: [
            "name",
            "startTime",
            "endTime",
            "breakStartTime",
            "breakDurationMinutes",
            "gracePeriodMinutes",
            "lateThresholdMinutes",
            "earlyDepartureThresholdMinutes",
            "minimumWorkingHours",
            "overtimeEligible",
            "roundingRules",
            "workingDays",
          ],
        });
      }
    });
  } catch (error) {
    return { error: actionError(error) };
  }

  revalidatePath("/admin/shifts");
  revalidatePath("/admin/employees");
  redirect("/admin/shifts");
}

export async function deleteShiftAction(id: string) {
  const admin = await requirePermission("shift:manage");
  try {
    await prisma.$transaction(async (tx) => {
      const deleted = await deleteShift(admin, id, tx);
      await writeShiftAuditEvent(tx, { shiftId: deleted.id, actorId: admin.id, operation: "DELETED" });
    });
  } catch (error) {
    redirect(`/admin/shifts?error=${encodeURIComponent(actionError(error))}`);
  }

  revalidatePath("/admin/shifts");
  revalidatePath("/admin/employees");
  redirect("/admin/shifts?success=Shift%20deleted.");
}
