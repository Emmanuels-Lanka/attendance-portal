"use client";

import { useActionState } from "react";
import { correctAttendanceAction } from "@/app/(workspace)/admin/attendance/actions";
import type { AttendanceCorrectionState } from "@/app/(workspace)/admin/attendance/actions";

type CorrectionValues = {
  sessionId: string;
  localDate: string;
  timeZone: string;
  startAt: string;
  endAt: string;
  mode: "OFFICE" | "WFH";
};

export function AdminAttendanceCorrectionForm({ sessionId, localDate, timeZone, startAt, endAt, mode }: CorrectionValues) {
  const action = correctAttendanceAction.bind(null, sessionId);
  const [state, formAction, pending] = useActionState<AttendanceCorrectionState, FormData>(action, null);

  return (
    <details className="min-w-[210px]">
      <summary className="cursor-pointer text-xs font-medium text-[var(--blue)]">Correct session</summary>
      <form action={formAction} onSubmit={(event) => {
        const outTime = (event.currentTarget.elements.namedItem("endAt") as HTMLInputElement).value;
        if (endAt && !outTime && !window.confirm("Reopen this completed session? The change will be recorded in audit history.")) event.preventDefault();
      }} className="mt-3 grid gap-2 rounded-md border border-[var(--line)] bg-white p-3 shadow-sm">
        <p className="text-[11px] leading-4 text-[var(--muted)]">
          Session&apos;s employee-local IN date: {localDate} ({timeZone}). Effective IN: {startAt || "Unavailable"}; effective OUT: {endAt || "not recorded"}.
        </p>
        <p className="rounded-md bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-900">
          Corrected endpoints may use another employee-local date. Original raw punches are preserved for review, and attendance calculations use the corrected effective times.
        </p>
        <label className="text-[11px] font-semibold text-[var(--muted)]">Employee-local IN time
          <input name="startAt" type="datetime-local" step="1" required defaultValue={startAt} className="mt-1 h-9 w-full rounded-md border border-[var(--line)] bg-white px-2 text-xs text-[var(--ink)]" />
        </label>
        <label className="text-[11px] font-semibold text-[var(--muted)]">Employee-local OUT time
          <input name="endAt" type="datetime-local" step="1" defaultValue={endAt} className="mt-1 h-9 w-full rounded-md border border-[var(--line)] bg-white px-2 text-xs text-[var(--ink)]" />
        </label>
        <p className="text-[10px] leading-4 text-[var(--muted)]">Clear OUT only to reverse a mistaken close. The change is recorded in audit history.</p>
        <label className="text-[11px] font-semibold text-[var(--muted)]">Work mode
          <select name="mode" defaultValue={mode} className="mt-1 h-9 w-full rounded-md border border-[var(--line)] bg-white px-2 text-xs text-[var(--ink)]">
            <option value="OFFICE">Office</option>
            <option value="WFH">WFH</option>
          </select>
        </label>
        <label className="text-[11px] font-semibold text-[var(--muted)]">Reason for correction
          <textarea name="reason" required maxLength={500} className="mt-1 min-h-16 w-full rounded-md border border-[var(--line)] bg-white px-2 py-2 text-xs text-[var(--ink)]" />
        </label>
        {state && "error" in state && <p role="alert" className="text-xs text-[var(--danger)]">{state.error}</p>}
        {state && "success" in state && <p role="status" className="text-xs text-[var(--mint-ink)]">{state.success}</p>}
        <button type="submit" disabled={pending} className="mt-1 h-9 rounded-md bg-[var(--action)] px-3 text-xs font-semibold text-white hover:bg-[var(--action-hover)] disabled:opacity-60">{pending ? "Saving..." : "Save correction"}</button>
      </form>
    </details>
  );
}