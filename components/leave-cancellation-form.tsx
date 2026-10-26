"use client";

import { useActionState } from "react";
import {
  requestLeaveCancellationAction,
  type LeaveRequestActionState,
} from "@/app/(workspace)/leave/actions";

export function LeaveCancellationForm({ leaveRequestId }: { leaveRequestId: string }) {
  const action = requestLeaveCancellationAction.bind(null, leaveRequestId);
  const [state, formAction, pending] = useActionState<LeaveRequestActionState, FormData>(action, null);

  return (
    <form action={formAction} className="mt-6 space-y-3 border-t border-[var(--line)] pt-5">
      <h2 className="text-sm font-semibold">Cancel this request</h2>
      <label className="block text-sm font-medium">
        Cancellation reason
        <textarea name="reason" required maxLength={500} rows={3} className="mt-1.5 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm font-normal" />
      </label>
      {state && "error" in state && <p role="alert" className="text-sm text-[var(--danger)]">{state.error}</p>}
      {state && "success" in state && <p role="status" className="text-sm text-[var(--mint-ink)]">{state.success}</p>}
      <button type="submit" disabled={pending} className="h-9 rounded-md border border-[var(--line)] px-3 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-60">
        {pending ? "Submitting..." : "Request cancellation"}
      </button>
    </form>
  );
}
