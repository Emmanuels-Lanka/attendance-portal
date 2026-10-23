"use client";

import { useActionState } from "react";
import {
  submitAttendanceCorrectionAction,
  type AttendanceCorrectionSubmissionState,
} from "@/app/(workspace)/attendance/corrections/actions";

export function AttendanceCorrectionRequestForm({
  dailyAttendanceId,
  date,
  status,
  firstIn,
  lastOut,
  timeZone,
  hasPendingRequest,
}: {
  dailyAttendanceId: string;
  date: string;
  status: string | null;
  firstIn: string;
  lastOut: string;
  timeZone: string;
  hasPendingRequest: boolean;
}) {
  const [state, formAction, pending] = useActionState<AttendanceCorrectionSubmissionState, FormData>(
    submitAttendanceCorrectionAction,
    null,
  );

  return (
    <article className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Attendance for {date}</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">Calculated status: {status ?? "Unavailable"}</p>
        </div>
        <p className="text-xs text-[var(--muted)]">{timeZone}</p>
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-[var(--muted)]">Current IN</dt><dd className="mt-1 font-medium">{firstIn || "Not recorded"}</dd></div>
        <div><dt className="text-xs text-[var(--muted)]">Current OUT</dt><dd className="mt-1 font-medium">{lastOut || "Not recorded"}</dd></div>
      </dl>

      {hasPendingRequest && (
        <p role="status" className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          A correction request for this attendance date is awaiting review.
        </p>
      )}
      <form action={formAction} className="mt-5 space-y-4 border-t border-[var(--line)] pt-4">
        <input type="hidden" name="dailyAttendanceId" value={dailyAttendanceId} />
        <p className="text-sm font-medium">Requested times <span className="font-normal text-[var(--muted)]">(leave unchanged fields blank)</span></p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-semibold">
            Corrected IN
            <input name="firstIn" type="datetime-local" disabled={hasPendingRequest} className="mt-1.5 h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal disabled:bg-slate-50" />
          </label>
          <label className="block text-sm font-semibold">
            Corrected OUT
            <input name="lastOut" type="datetime-local" disabled={hasPendingRequest} className="mt-1.5 h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal disabled:bg-slate-50" />
          </label>
        </div>
        {(firstIn || lastOut) && (
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {firstIn && <label className="inline-flex items-center gap-2 text-sm"><input name="clearFirstIn" type="checkbox" value="on" disabled={hasPendingRequest} className="size-4 rounded border-[var(--line)] disabled:opacity-50" />Remove recorded IN time</label>}
            {lastOut && <label className="inline-flex items-center gap-2 text-sm"><input name="clearLastOut" type="checkbox" value="on" disabled={hasPendingRequest} className="size-4 rounded border-[var(--line)] disabled:opacity-50" />Remove recorded OUT time</label>}
          </div>
        )}
        <label className="block text-sm font-semibold">
          Reason
          <textarea name="reason" required maxLength={500} rows={3} disabled={hasPendingRequest} className="mt-1.5 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm font-normal disabled:bg-slate-50" />
        </label>
        {state && "error" in state && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{state.error}</p>}
        {state && "success" in state && <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{state.success}</p>}
        <button type="submit" disabled={pending || hasPendingRequest} className="h-10 rounded-md bg-[var(--action)] px-4 text-sm font-semibold text-white hover:bg-[var(--action-hover)] disabled:opacity-60">
          {pending ? "Submitting..." : hasPendingRequest ? "Request pending" : "Submit correction request"}
        </button>
      </form>
    </article>
  );
}
