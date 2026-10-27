"use client";

import { useActionState } from "react";
import {
  submitAttendanceCorrectionAction,
  type AttendanceCorrectionSubmissionState,
} from "@/app/(workspace)/attendance/corrections/actions";

export function AttendanceDateCorrectionRequestForm({
  attendanceDate,
  timeZone,
}: {
  attendanceDate: string;
  timeZone: string;
}) {
  const [state, formAction, pending] = useActionState<AttendanceCorrectionSubmissionState, FormData>(
    submitAttendanceCorrectionAction,
    null,
  );

  return (
    <article className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-base font-semibold">Request correction for any attendance date</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          This request can repair a missing session. The selected date and both corrected times use {timeZone}; blank times preserve recorded endpoints.
          Overnight attendance calculations are not supported. If an OUT was genuinely recorded on a later local date, do not move it back to this date; contact HR to resolve the raw punch history.
        </p>
      </div>
      <form action={formAction} className="mt-5 space-y-4">
        <label className="block text-sm font-semibold">
          Attendance date
          <input
            name="attendanceDate"
            type="date"
            required
            defaultValue={attendanceDate}
            className="mt-1.5 h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal"
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-semibold">
            Actual IN / WFH-IN time
            <input
              name="firstIn"
              type="datetime-local"
              step="1"
              className="mt-1.5 h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal"
            />
          </label>
          <label className="block text-sm font-semibold">
            Actual OUT / WFH-OUT time
            <input
              name="lastOut"
              type="datetime-local"
              step="1"
              className="mt-1.5 h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal"
            />
          </label>
        </div>
        <label className="block text-sm font-semibold">
          Correct work mode
          <select name="requestedMode" required defaultValue="" className="mt-1.5 h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal">
            <option value="" disabled>Choose a work mode</option>
            <option value="OFFICE">Office</option>
            <option value="WFH">Work from home</option>
          </select>
        </label>
        <label className="block text-sm font-semibold">
          Reason
          <textarea name="reason" required maxLength={500} rows={3} className="mt-1.5 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm font-normal" />
        </label>
        {state && "error" in state && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{state.error}</p>}
        {state && "success" in state && <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{state.success}</p>}
        <button type="submit" disabled={pending} className="h-10 rounded-md bg-[var(--action)] px-4 text-sm font-semibold text-white hover:bg-[var(--action-hover)] disabled:opacity-60">
          {pending ? "Submitting..." : "Submit correction request"}
        </button>
      </form>
    </article>
  );
}
