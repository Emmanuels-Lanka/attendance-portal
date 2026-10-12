"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/session";
import {
  LeaveEntitlementAccessError,
  LeaveEntitlementEmployeeNotFoundError,
  LeaveEntitlementTypeNotFoundError,
  setLeaveEntitlement,
} from "@/lib/leave/balance-service";

export type LeaveEntitlementActionState = { error: string } | { success: string } | null;

function actionError(error: unknown) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Check the entitlement values.";
  if (
    error instanceof LeaveEntitlementAccessError
    || error instanceof LeaveEntitlementEmployeeNotFoundError
    || error instanceof LeaveEntitlementTypeNotFoundError
  ) return error.message;
  console.error("Leave entitlement action failed", error instanceof Error ? error.name : "Unknown error");
  return "The Leave entitlement could not be saved. Try again shortly.";
}

export async function saveLeaveEntitlementAction(
  _state: LeaveEntitlementActionState,
  formData: FormData,
): Promise<LeaveEntitlementActionState> {
  const actor = await requirePermission("leave:manage");
  try {
    await setLeaveEntitlement(actor, {
      employeeId: formData.get("employeeId"),
      leaveTypeId: formData.get("leaveTypeId"),
      periodStart: formData.get("periodStart"),
      periodEnd: formData.get("periodEnd"),
      openingBalance: formData.get("openingBalance"),
      entitlement: formData.get("entitlement"),
      carryForward: formData.get("carryForward"),
      reason: formData.get("reason"),
    });
    revalidatePath("/admin/leave-balances");
    revalidatePath("/leave/balance");
    revalidatePath("/admin/audit");
    return { success: "Leave entitlement saved." };
  } catch (error) {
    return { error: actionError(error) };
  }
}