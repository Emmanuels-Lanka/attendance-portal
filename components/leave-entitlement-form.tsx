"use client";

import { useActionState } from "react";
import {
  saveLeaveEntitlementAction,
  type LeaveEntitlementActionState,
} from "@/app/(workspace)/admin/leave-balances/actions";

export function LeaveEntitlementForm({
  employeeId,
  leaveTypeId,
  periodStart,
  periodEnd,
  openingBalance,
  entitlement,
  carryForward,
}: {
  employeeId: string;
  leaveTypeId: string;
  periodStart: string;
  periodEnd: string;
  openingBalance?: string;
  entitlement?: string;
  carryForward?: string;
}) {
  const [state, formAction, pending] = useActionState<LeaveEntitlementActionState, FormData>(
    saveLeaveEntitlementAction,
    null,
  );

  return (
    <form action={formAction} className="max-w-3xl space-y-5 rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm sm:p-7">
      <input type="hidden" name="employeeId" value={employeeId} />
      <input type="hidden" name="leaveTypeId" value={leaveTypeId} />
      <input type="hidden" name="periodStart" value={periodStart} />
      <input type="hidden" name="periodEnd" value={periodEnd} />
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block text-sm font-semibold">
          Opening balance (days)
          <input name="openingBalance" type="number" min="0" max="9999999999.99" step="0.01" required defaultValue={openingBalance} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal" />
        </label>
        <label className="block text-sm font-semibold">
          Entitlement (days)
          <input name="entitlement" type="number" min="0" max="9999999999.99" step="0.01" required defaultValue={entitlement} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal" />
        </label>
        <label className="block text-sm font-semibold">
          Carry forward (days)
          <input name="carryForward" type="number" min="0" max="9999999999.99" step="0.01" required defaultValue={carryForward} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal" />
        </label>
      </div>
      <label className="block text-sm font-semibold">
        Reason for change
        <textarea name="reason" required maxLength={500} rows={3} className="mt-1.5 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm font-normal" />
      </label>
      {state && "error" in state && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{state.error}</p>}
      {state && "success" in state && <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{state.success}</p>}
      <button type="submit" disabled={pending} className="h-10 rounded-md bg-[var(--action)] px-4 text-sm font-semibold text-white hover:bg-[var(--action-hover)] disabled:opacity-60">
        {pending ? "Saving..." : "Save entitlement"}
      </button>
    </form>
  );
}