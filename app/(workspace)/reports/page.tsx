import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";

import { formatWorkedDuration } from "@/lib/attendance/history";
import { getEmployeeMonthlyReport } from "@/lib/attendance/reports";
import { requirePageUser } from "@/lib/auth/session";

export default async function ReportsPage({
  searchParams,
}: {
  searchParams?: Promise<{ month?: string | string[]; [key: string]: string | string[] | undefined }>;
}) {
  const user = await requirePageUser();
  const params = (await searchParams) ?? {};
  const currentMonth = formatInTimeZone(new Date(), user.timeZone, "yyyy-MM");
  const requestedMonth = typeof params.month === "string" ? params.month : "";
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth);
  const month = validMonth ? requestedMonth : currentMonth;
  const report = await getEmployeeMonthlyReport(user, month);
  const summaryMetrics = [
    { label: "Scheduled workdays", value: report.summary.totalWorkingDays ?? "Unavailable" },
    { label: "Present", value: report.summary.presentDays ?? "Not calculated" },
    { label: "Late arrivals", value: report.summary.lateDays ?? "Not calculated" },
    { label: "Early departures", value: report.summary.earlyOutDays ?? "Not calculated" },
    { label: "Approved leave", value: report.summary.approvedLeaveDays ?? "Unavailable" },
      { label: "WFH days", value: report.summary.workFromHomeDays ?? 0 },
    { label: "Holidays", value: report.summary.holidayDays ?? 0 },
    { label: "Absent", value: report.summary.absentDays ?? "Not calculated" },
    { label: "Missing punch", value: report.summary.missingPunchDays ?? 0 },
    { label: "Weekend", value: report.summary.weekendDays ?? 0 },
    { label: "Undetermined", value: report.summary.undeterminedDays ?? 0 },
    { label: "Calculated dates", value: report.summary.totalCalculatedDays ?? 0 },
    { label: "Session time", value: formatWorkedDuration(report.summary.totalWorkedMs) },
    { label: "Engine-calculated hours", value: report.summary.engineWorkedMs === null || report.summary.engineWorkedMs === undefined ? "Not calculated" : formatWorkedDuration(report.summary.engineWorkedMs) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium text-[var(--blue)]">Personal records</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Monthly attendance summary</h1>
        </div>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-3">
          <form method="GET" className="flex w-full items-center gap-2 lg:w-auto">
            <label htmlFor="personal-report-month" className="sr-only">Summary month</label>
            <input id="personal-report-month" type="month" name="month" defaultValue={month} className="min-w-0 flex-1 rounded-md border border-[var(--line)] px-3 py-2 text-sm lg:flex-none" />
            <button type="submit" className="rounded-md bg-[var(--action)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--action-hover)]">Apply</button>
          </form>
          <div className="flex flex-wrap gap-2">
            <Link href={`/reports/export?month=${month}&format=pdf`} className="inline-flex justify-center rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium text-[var(--ink)]">Download PDF</Link>
            <Link href={`/reports/export?month=${month}&format=xlsx`} className="inline-flex justify-center rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium text-[var(--ink)]">Download Excel</Link>
            <Link href={`/reports/export?month=${month}&format=csv`} className="inline-flex justify-center rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium text-[var(--ink)]">Download CSV</Link>
          </div>
        </div>
      </div>

      {requestedMonth && !validMonth && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Invalid month. Showing the current month instead.</p>}

      <section aria-labelledby="monthly-summary-title" className="space-y-3">
        <div><h2 id="monthly-summary-title" className="text-base font-semibold">Summary for {month}</h2><p className="mt-1 text-xs text-[var(--muted)]">Attendance statuses reflect saved daily calculations; session time and engine-calculated hours are shown separately.</p></div>
          <div><h2 id="monthly-summary-title" className="text-base font-semibold">Summary for {month}</h2><p className="mt-1 text-xs text-[var(--muted)]">Saved corrected daily rows take precedence; other punch dates use the attendance engine.</p></div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
          {summaryMetrics.map(({ label, value }) => (
            <div key={label} className="min-h-24 rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm">
              <p className="text-xs font-medium text-[var(--muted)]">{label}</p>
              <p className="mt-3 text-xl font-semibold tabular-nums">{value}</p>
            </div>
          ))}
        </div>
        {report.summary.absentDays === null && <p role="note" className="text-xs text-[var(--muted)]">Absence is shown only when an ABSENT status has been explicitly saved; missing attendance is not automatically classified as absence.</p>}
        {report.summary.totalWorkingDays === null && <p role="note" className="text-xs text-[var(--muted)]">Scheduled workdays are unavailable because no Shift with working days is assigned.</p>}
        {(report.summary.totalCalculatedDays ?? 0) > 0 && <p className="text-xs text-[var(--muted)]">Status counts cover {report.summary.totalCalculatedDays} dates with saved or on-demand engine results; unpunched scheduled days are not inferred as absences.</p>}
        {report.summary.engineCalculatedDays !== undefined && report.summary.engineCalculatedDays > 0 && <p className="text-xs text-[var(--muted)]">Engine hours include {report.summary.engineCalculatedDays} date{report.summary.engineCalculatedDays === 1 ? "" : "s"} with stored daily calculations.</p>}
      </section>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm"><p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Sessions</p><p className="mt-2 text-2xl font-semibold">{report.summary.totalSessions}</p></div>
        <div className="rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm"><p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Completed</p><p className="mt-2 text-2xl font-semibold">{report.summary.completedSessions}</p></div>
        <div className="rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm"><p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Active</p><p className="mt-2 text-2xl font-semibold">{report.summary.activeSessions}</p></div>
        <div className="rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm"><p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Worked</p><p className="mt-2 text-2xl font-semibold">{formatWorkedDuration(report.summary.totalWorkedMs)}</p></div>
      </div>

      <section className="rounded-lg border border-[var(--line)] bg-white shadow-sm">
        <header className="border-b border-[var(--line)] px-5 py-4"><h2 className="text-base font-semibold">Daily breakdown</h2></header>
        <div className="divide-y divide-[var(--line)]">
          {report.days.length === 0 ? (
            <div className="px-5 py-8 text-sm text-[var(--muted)]">No attendance sessions were recorded for this month.</div>
          ) : (
            report.days.map((day) => (
              <div key={day.date} className="px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-semibold">{day.date}</p>
                  {day.approvedWorkFromHome && <span className="rounded-sm bg-slate-100 px-2 py-1 text-xs font-medium text-[var(--blue)]">Approved WFH</span>}
                  <p className="text-xs text-[var(--muted)]">{formatWorkedDuration(day.totalWorkedMs)}</p>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {day.sessions.map((session) => (
                    <span key={session.id} className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-[var(--ink)]">
                      {session.mode} · {session.endAt ? formatWorkedDuration(new Date(session.endAt).getTime() - new Date(session.startAt).getTime()) : "Active"}
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

    </div>
  );
}