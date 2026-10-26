"use client";

import Link from "next/link";
import { useState } from "react";
import { useActionState } from "react";
import { submitLeaveRequestAction, type LeaveRequestActionState } from "@/app/(workspace)/leave/actions";

type LeaveDurationMode = "FULL_DAY" | "HALF_DAY" | "TIME_BASED";
type LeaveTypeOption = { id: string; name: string; durationMode: LeaveDurationMode };
type DocumentOption = { id: string; type: string; originalFilename: string; uploadedAt: Date };

function durationMinutes(start: string, end: string) {
  const toMinutes = (value: string) => {
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
  };
  if (!start || !end) return null;
  const duration = toMinutes(end) - toMinutes(start);
  return duration > 0 ? duration : null;
}

export function LeaveRequestForm({
  leaveTypes,
  documents,
}: {
  leaveTypes: LeaveTypeOption[];
  documents: DocumentOption[];
}) {
  const [state, formAction, pending] = useActionState<LeaveRequestActionState, FormData>(submitLeaveRequestAction, null);
  const [mode, setMode] = useState<LeaveDurationMode | null>(null);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const timeDuration = durationMinutes(startTime, endTime);

  return (
    <form action={formAction} className="max-w-2xl space-y-5 rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm sm:p-7">
      <label htmlFor="leave-type" className="block text-sm font-semibold">
        Leave Type
        <select
          id="leave-type"
          name="leaveTypeId"
          required
          defaultValue=""
          onChange={(event) => setMode(leaveTypes.find((type) => type.id === event.currentTarget.value)?.durationMode ?? null)}
          className="mt-1.5 h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal"
        >
          <option value="" disabled>Select a Leave Type</option>
          {leaveTypes.map((leaveType) => <option key={leaveType.id} value={leaveType.id}>{leaveType.name}</option>)}
        </select>
      </label>
      {mode === "FULL_DAY" || mode === null ? (
        <div className="grid gap-5 sm:grid-cols-2">
          <label htmlFor="start-date" className="block text-sm font-semibold">
            Start Date
            <input id="start-date" name="startDate" type="date" required className="mt-1.5 h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal" />
          </label>
          <label htmlFor="end-date" className="block text-sm font-semibold">
            End Date
            <input id="end-date" name="endDate" type="date" required className="mt-1.5 h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal" />
          </label>
        </div>
      ) : (
        <div className="space-y-4">
          <label htmlFor="leave-date" className="block text-sm font-semibold">
            Leave Date
            <input id="leave-date" name="leaveDate" type="date" required className="mt-1.5 h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal" />
          </label>
          {mode === "HALF_DAY" && (
            <label htmlFor="half-day-period" className="block text-sm font-semibold">
              Half-day period
              <select id="half-day-period" name="halfDayPeriod" required defaultValue="" className="mt-1.5 h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal">
                <option value="" disabled>Select a period</option>
                <option value="MORNING">Morning</option>
                <option value="AFTERNOON">Afternoon</option>
              </select>
            </label>
          )}
          {mode === "TIME_BASED" && (
            <div className="grid gap-5 sm:grid-cols-2">
              <label htmlFor="leave-start-time" className="block text-sm font-semibold">
                Start time
                <input id="leave-start-time" name="startTime" type="time" required value={startTime} onChange={(event) => setStartTime(event.currentTarget.value)} className="mt-1.5 h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal" />
              </label>
              <label htmlFor="leave-end-time" className="block text-sm font-semibold">
                End time
                <input id="leave-end-time" name="endTime" type="time" required value={endTime} onChange={(event) => setEndTime(event.currentTarget.value)} className="mt-1.5 h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal" />
              </label>
              <p className="text-sm text-[var(--muted)] sm:col-span-2" aria-live="polite">
                {timeDuration === null ? "Choose an end time after the start time." : `Requested duration: ${Math.floor(timeDuration / 60)}h ${timeDuration % 60}m`}
              </p>
            </div>
          )}
        </div>
      )}
      <label htmlFor="reason" className="block text-sm font-semibold">
        Reason
        <textarea id="reason" name="reason" required maxLength={500} rows={4} className="mt-1.5 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm font-normal" />
      </label>
      <label htmlFor="attachment-document" className="block text-sm font-semibold">
        Supporting document <span className="font-normal text-[var(--muted)]">(optional)</span>
        <select id="attachment-document" name="attachmentDocumentId" defaultValue="" className="mt-1.5 h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal">
          <option value="">No document attached</option>
          {documents.map((document) => (
            <option key={document.id} value={document.id}>
              {document.originalFilename} ({document.type.replaceAll("_", " ").toLowerCase()})
            </option>
          ))}
        </select>
        {documents.length === 0 && <span className="mt-1 block text-xs font-normal text-[var(--muted)]">No Employee Documents are available to attach.</span>}
      </label>
      {state && "error" in state && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{state.error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending || leaveTypes.length === 0 || (mode === "TIME_BASED" && timeDuration === null)} className="h-10 rounded-md bg-[var(--action)] px-4 text-sm font-semibold text-white hover:bg-[var(--action-hover)] disabled:opacity-60">
          {pending ? "Submitting..." : "Submit request"}
        </button>
        <Link href="/leave" className="inline-flex h-10 items-center rounded-md border border-[var(--line)] px-4 text-sm font-medium">Cancel</Link>
      </div>
      {leaveTypes.length === 0 && <p role="status" className="text-sm text-[var(--muted)]">Leave requests are unavailable because no Leave Types are configured.</p>}
    </form>
  );
}
