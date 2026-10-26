"use client";

import Link from "next/link";
import { useActionState } from "react";
import { saveShiftAction, type ShiftActionState } from "@/app/(workspace)/admin/shifts/actions";
import { shiftWeekdays, type ShiftWeekday } from "@/lib/shifts/validation";

const weekdayLabels: Record<ShiftWeekday, string> = {
  MONDAY: "Monday",
  TUESDAY: "Tuesday",
  WEDNESDAY: "Wednesday",
  THURSDAY: "Thursday",
  FRIDAY: "Friday",
  SATURDAY: "Saturday",
  SUNDAY: "Sunday",
};

type ShiftFormProps = {
  id?: string;
  name?: string;
  startTime?: string;
  endTime?: string;
  breakStartTime?: string | null;
  breakDurationMinutes?: number | null;
  gracePeriodMinutes?: number | null;
  lateThresholdMinutes?: number | null;
  earlyDepartureThresholdMinutes?: number | null;
  minimumWorkingHours?: string | null;
  overtimeEligible?: boolean | null;
  roundingRules?: string | null;
  workingDays?: ShiftWeekday[];
};

export function ShiftForm({
  id,
  name,
  startTime,
  endTime,
  breakStartTime,
  breakDurationMinutes,
  gracePeriodMinutes,
  lateThresholdMinutes,
  earlyDepartureThresholdMinutes,
  minimumWorkingHours,
  overtimeEligible,
  roundingRules,
  workingDays = [],
}: ShiftFormProps) {
  const action = saveShiftAction.bind(null, id ?? null);
  const [state, formAction, pending] = useActionState<ShiftActionState, FormData>(action, null);

  return (
    <form action={formAction} className="max-w-3xl space-y-5 rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm sm:p-7">
      <label htmlFor="shift-name" className="block text-sm font-semibold">
        Shift name
        <input id="shift-name" name="name" required autoFocus maxLength={120} defaultValue={name ?? ""} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal" />
      </label>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Shift configuration</legend>
        <p className="text-xs text-[var(--muted)]">Leave a setting blank if it has not been configured. Rounding rules are stored as JSON without interpretation.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label htmlFor="shift-start-time" className="text-sm font-medium">Start time<input id="shift-start-time" name="startTime" type="time" defaultValue={startTime ?? ""} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 font-normal" /></label>
          <label htmlFor="shift-end-time" className="text-sm font-medium">End time<input id="shift-end-time" name="endTime" type="time" defaultValue={endTime ?? ""} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 font-normal" /></label>
          <label htmlFor="shift-break-duration" className="text-sm font-medium">Break duration (minutes)<input id="shift-break-duration" name="breakDurationMinutes" type="number" step="1" defaultValue={breakDurationMinutes ?? ""} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 font-normal" /></label>
          <label htmlFor="shift-break-start" className="text-sm font-medium">Break start time (required for half-day leave)<input id="shift-break-start" name="breakStartTime" type="time" defaultValue={breakStartTime ?? ""} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 font-normal" /></label>
          <label htmlFor="shift-grace-period" className="text-sm font-medium">Grace period (minutes)<input id="shift-grace-period" name="gracePeriodMinutes" type="number" step="1" defaultValue={gracePeriodMinutes ?? ""} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 font-normal" /></label>
          <label htmlFor="shift-late-threshold" className="text-sm font-medium">Late threshold (minutes)<input id="shift-late-threshold" name="lateThresholdMinutes" type="number" step="1" defaultValue={lateThresholdMinutes ?? ""} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 font-normal" /></label>
          <label htmlFor="shift-early-departure-threshold" className="text-sm font-medium">Early departure threshold (minutes)<input id="shift-early-departure-threshold" name="earlyDepartureThresholdMinutes" type="number" step="1" defaultValue={earlyDepartureThresholdMinutes ?? ""} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 font-normal" /></label>
          <label htmlFor="shift-minimum-working-hours" className="text-sm font-medium">Minimum working hours<input id="shift-minimum-working-hours" name="minimumWorkingHours" type="number" max="999999.99" min="-999999.99" step="0.01" defaultValue={minimumWorkingHours ?? ""} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 font-normal" /></label>
          <label htmlFor="shift-overtime-eligibility" className="text-sm font-medium">Overtime eligibility<select id="shift-overtime-eligibility" name="overtimeEligible" defaultValue={overtimeEligible == null ? "" : String(overtimeEligible)} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 font-normal"><option value="">Not configured</option><option value="true">Eligible</option><option value="false">Not eligible</option></select></label>
        </div>
        <label htmlFor="shift-rounding-rules" className="block text-sm font-medium">Rounding rules (JSON)<textarea id="shift-rounding-rules" name="roundingRules" rows={5} defaultValue={roundingRules ?? ""} spellCheck={false} className="mt-1.5 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 font-mono text-sm font-normal" /></label>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Scheduled working days</legend>
        <p className="text-xs text-[var(--muted)]">Select the days employees on this shift are scheduled to work. No days are preselected.</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {shiftWeekdays.map((day) => (
            <label key={day} className="flex items-center gap-2 rounded-md border border-[var(--line)] px-3 py-2 text-sm">
              <input type="checkbox" name="workingDays" value={day} defaultChecked={workingDays.includes(day)} />
              {weekdayLabels[day]}
            </label>
          ))}
        </div>
      </fieldset>
      {state?.error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{state.error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className="h-10 rounded-md bg-[var(--action)] px-4 text-sm font-semibold text-white hover:bg-[var(--action-hover)] disabled:opacity-60">{pending ? "Saving..." : id ? "Save shift" : "Create shift"}</button>
        <Link href="/admin/shifts" className="inline-flex h-10 items-center rounded-md border border-[var(--line)] px-4 text-sm font-medium">Cancel</Link>
      </div>
    </form>
  );
}
