import React, { type ReactNode } from "react";

export function HrSelfAttendance({
  employeeRecordFound,
  controls,
}: {
  employeeRecordFound: boolean;
  controls: ReactNode;
}) {
  if (!employeeRecordFound) {
    return (
      <section aria-labelledby="hr-self-attendance-title" className="rounded-lg border border-[var(--line)] bg-white px-5 py-5 shadow-sm">
        <h2 id="hr-self-attendance-title" className="text-base font-semibold">Your attendance</h2>
        <p role="status" className="mt-2 text-sm text-[var(--muted)]">
          Attendance is unavailable because your account has no linked Employee record. Ask an administrator to link your account before recording attendance.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="hr-self-attendance-title" className="space-y-3">
      <h2 id="hr-self-attendance-title" className="text-base font-semibold">Your attendance</h2>
      {controls}
    </section>
  );
}
