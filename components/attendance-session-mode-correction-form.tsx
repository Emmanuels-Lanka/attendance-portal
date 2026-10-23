"use client";

import { useActionState } from "react";
import {
  submitAttendanceSessionModeCorrectionAction,
  type AttendanceCorrectionSubmissionState,
} from "@/app/(workspace)/attendance/corrections/actions";

export function AttendanceSessionModeCorrectionForm({
  sessionId,
  currentMode,
  requestedAt,
  completed,
  hasPendingRequest,
}: {
  sessionId: string;
  currentMode: "OFFICE" | "WFH";
  requestedAt: string;
  completed: boolean;
  hasPendingRequest: boolean;
}) {
  const [state, formAction, pending] = useActionState<AttendanceCorrectionSubmissionState, FormData>(
    submitAttendanceSessionModeCorrectionAction,
    null,
  );
  const requestedMode = currentMode === "WFH" ? "OFFICE" : "WFH";

  return (
    <article className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{currentMode === "WFH" ? "WFH" : "Office"} session</h3>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Started {requestedAt}{completed ? " · Completed" : " · Active"}
          </p>
        </div>
        <span className="rounded-sm bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
          Recorded as {currentMode === "WFH" ? "WFH-IN" : "IN"}
        </span>
      </div>
      {hasPendingRequest ? (
        <p role="status" className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          A work-mode correction for this session is awaiting review. The recorded mode remains unchanged until final approval.
        </p>
      ) : (
        <form action={formAction} className="mt-4 space-y-3 border-t border-[var(--line)] pt-4">
          <input type="hidden" name="sessionId" value={sessionId} />
          <input type="hidden" name="requestedMode" value={requestedMode} />
          <p className="text-sm">
            If this was the wrong punch type, request correction to <strong>{requestedMode === "WFH" ? "WFH-IN" : "IN"}</strong>.
            Your original punch evidence will be retained.
          </p>
          <label className="block text-sm font-semibold">
            Reason
            <textarea name="reason" required maxLength={500} rows={2} className="mt-1.5 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm font-normal" />
          </label>
          {state && "error" in state && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{state.error}</p>}
          {state && "success" in state && <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{state.success}</p>}
          <button type="submit" disabled={pending} className="h-10 rounded-md bg-[var(--action)] px-4 text-sm font-semibold text-white hover:bg-[var(--action-hover)] disabled:opacity-60">
            {pending ? "Submitting..." : `Request ${requestedMode === "WFH" ? "WFH" : "office"} correction`}
          </button>
        </form>
      )}
    </article>
  );
}
