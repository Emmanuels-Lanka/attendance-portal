"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import {
  createLeaveType,
  deleteLeaveType,
  getLeaveType,
  LeaveTypeInUseError,
  LeaveTypeNotFoundError,
  updateLeaveType,
  writeLeaveTypeAuditEvent,
} from "@/lib/leave/service";

export type LeaveTypeActionState = { error: string } | null;

function actionError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Enter a valid Leave Type name.";
  if (error instanceof LeaveTypeInUseError || error instanceof LeaveTypeNotFoundError) return error.message;
  console.error("Leave Type management action failed", error instanceof Error ? error.name : "Unknown error");
  return "The Leave Type could not be saved. Try again shortly.";
}

export async function saveLeaveTypeAction(
  id: string | null,
  _state: LeaveTypeActionState,
  formData: FormData,
): Promise<LeaveTypeActionState> {
  try {
    const admin = await requireAdmin();
    await prisma.$transaction(async (tx) => {
      if (id) {
        const before = await getLeaveType(admin, id, tx);
        const updated = await updateLeaveType(admin, id, {
          name: formData.get("name"),
          durationMode: formData.get("durationMode"),
        }, tx);
        if (before.name !== updated.name || before.durationMode !== updated.durationMode) {
          await writeLeaveTypeAuditEvent(tx, { leaveTypeId: id, actorId: admin.id, operation: "UPDATED" });
        }
      } else {
        const created = await createLeaveType(admin, {
          name: formData.get("name"),
          durationMode: formData.get("durationMode"),
        }, tx);
        await writeLeaveTypeAuditEvent(tx, { leaveTypeId: created.id, actorId: admin.id, operation: "CREATED" });
      }
    });
  } catch (error) {
    return { error: actionError(error) };
  }

  revalidatePath("/admin/leave-types");
  revalidatePath("/admin/audit");
  redirect("/admin/leave-types");
}

export async function deleteLeaveTypeAction(id: string) {
  const admin = await requireAdmin();
  try {
    await prisma.$transaction(async (tx) => {
      const deleted = await deleteLeaveType(admin, id, tx);
      await writeLeaveTypeAuditEvent(tx, { leaveTypeId: deleted.id, actorId: admin.id, operation: "DELETED" });
    });
  } catch (error) {
    redirect(`/admin/leave-types?error=${encodeURIComponent(actionError(error))}`);
  }

  revalidatePath("/admin/leave-types");
  revalidatePath("/admin/audit");
  redirect(`/admin/leave-types?success=${encodeURIComponent("Leave Type deleted.")}`);
}
