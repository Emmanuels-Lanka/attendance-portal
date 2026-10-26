"use client";

import Link from "next/link";
import { useActionState } from "react";
import { saveLeaveTypeAction, type LeaveTypeActionState } from "@/app/(workspace)/admin/leave-types/actions";

export function LeaveTypeForm({ id, name, durationMode }: { id?: string; name?: string; durationMode?: "FULL_DAY" | "HALF_DAY" | "TIME_BASED" }) {
  const action = saveLeaveTypeAction.bind(null, id ?? null);
  const [state, formAction, pending] = useActionState<LeaveTypeActionState, FormData>(action, null);

  return (
    <form action={formAction} className="max-w-xl space-y-5 rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm sm:p-7">
      <label htmlFor="leave-type-name" className="block text-sm font-semibold">
        Leave Type name
        <input id="leave-type-name" name="name" required autoFocus maxLength={120} defaultValue={name ?? ""} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal" />
      </label>
      <label htmlFor="leave-type-duration-mode" className="block text-sm font-semibold">
        Leave duration
        <select id="leave-type-duration-mode" name="durationMode" defaultValue={durationMode ?? "FULL_DAY"} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal">
          <option value="FULL_DAY">Full day / date range</option>
          <option value="HALF_DAY">Half day (morning or afternoon)</option>
          <option value="TIME_BASED">Time-based short leave</option>
        </select>
      </label>
      {state?.error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{state.error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="h-10 rounded-md bg-[var(--action)] px-4 text-sm font-semibold text-white hover:bg-[var(--action-hover)] disabled:opacity-60">{pending ? "Saving..." : id ? "Save Leave Type" : "Create Leave Type"}</button>
        <Link href="/admin/leave-types" className="inline-flex h-10 items-center rounded-md border border-[var(--line)] px-4 text-sm font-medium">Cancel</Link>
      </div>
    </form>
  );
}
