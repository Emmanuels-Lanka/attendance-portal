import { formatInTimeZone } from "date-fns-tz";
import { CalendarDays } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminAttendanceCorrectionForm } from "@/components/admin-attendance-correction-form";
import { AttendancePunch } from "@/components/attendance-punch";
import { formatWorkedDuration } from "@/lib/attendance/history";
import { sessionView } from "@/lib/attendance/admin-session-view";
import { getAdminAttendanceSummary } from "@/lib/attendance/admin-dashboard";
import { getAdminAttendanceExceptions, type AttendanceExceptionCategory } from "@/lib/attendance/admin-exceptions";
import type { AttendanceReviewReason } from "@/lib/attendance/data-quality";
import { adminAttendanceFilterSchema, type AdminAttendanceFilters } from "@/lib/attendance/admin-validation";
import { listAdminAttendance } from "@/lib/attendance/admin-service";
import { hasPermission } from "@/lib/auth/permissions";
import { requirePageUser } from "@/lib/auth/session";

type SearchParams = Record<string, string | string[] | undefined>;

function sessionModeClass(mode: "OFFICE" | "WFH") {
  return mode === "WFH" ? "bg-slate-100 text-[var(--blue)]" : "bg-zinc-100 text-zinc-700";
}

const exceptionLabels: Record<AttendanceExceptionCategory, string> = {
  LATE_ARRIVAL: "Late arrival",
  EARLY_DEPARTURE: "Early departure",
  ACTIVE_SESSION: "Open session",
  NO_ATTENDANCE: "No attendance records",
};

const exceptionBadgeClasses: Record<AttendanceExceptionCategory, string> = {
  LATE_ARRIVAL: "bg-amber-50 text-amber-800",
  EARLY_DEPARTURE: "bg-amber-50 text-amber-800",
  ACTIVE_SESSION: "bg-[var(--mint)] text-[var(--mint-ink)]",
  NO_ATTENDANCE: "bg-slate-100 text-slate-700",
};

const reviewReasonLabels: Record<AttendanceReviewReason, string> = {
  INVALID_IN_TIMESTAMP: "IN timestamp is invalid",
  INVALID_OUT_TIMESTAMP: "OUT timestamp is invalid",
  OUT_BEFORE_IN: "OUT precedes IN",
  UNSAFE_DURATION: "Duration cannot be calculated safely",
};

function exceptionEmployeeHref(filters: AdminAttendanceFilters, employeeId?: string) {
  const params = new URLSearchParams({
    summaryDate: filters.summaryDate,
    from: filters.from,
    to: filters.to,
    mode: filters.mode,
    status: filters.status,
    exceptionCategory: filters.exceptionCategory,
    reviewReason: filters.reviewReason,
  });
  if (employeeId) params.set("employeeId", employeeId);
  return `/admin/attendance?${params.toString()}`;
}

export default async function AdminAttendancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const actor = await requirePageUser();
  const isAdmin = actor.role === "ADMIN";
  const canCorrectAttendance = isAdmin
    || (actor.role === "HR_ADMINISTRATOR" && hasPermission(actor.role, "attendance:correction:manage"))
    || (actor.role === "SUPERVISOR" && hasPermission(actor.role, "attendance:correction:approve"))
    || (actor.role === "DEPARTMENT_MANAGER" && hasPermission(actor.role, "attendance:correction:manage"));
  if (!canCorrectAttendance) redirect("/dashboard");
  const params = await searchParams;
  const filterResult = adminAttendanceFilterSchema.safeParse({
    employeeId: params.employeeId ?? "",
    summaryDate: params.summaryDate ?? "",
    from: params.from ?? "",
    to: params.to ?? "",
    mode: params.mode ?? "ALL",
    status: params.status ?? "ALL",
    exceptionCategory: params.exceptionCategory ?? "ALL",
    reviewReason: params.reviewReason ?? "ALL",
  });

  if (!filterResult.success) {
    return (
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-[var(--blue)]">Administration</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Attendance report</h1>
        </div>
        <section className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm" aria-label="Invalid attendance filters">
          <p role="alert" className="text-sm text-[var(--danger)]">{filterResult.error.issues[0]?.message ?? "One or more filters are invalid."}</p>
          <Link href="/admin/attendance" className="mt-4 inline-flex h-10 items-center rounded-md border border-[var(--line)] px-4 text-sm font-medium hover:bg-zinc-50">Clear filters</Link>
        </section>
      </div>
    );
  }

  const filters = filterResult.data;
  const { employees, sessions, dailySummaries } = await listAdminAttendance(actor, filters);
  const reviewItems = sessions.flatMap((session) => {
    const view = sessionView(session);
    if (!view.reviewReasons.length || (filters.reviewReason !== "ALL" && !view.reviewReasons.includes(filters.reviewReason))) return [];
    return [{ session, view }];
  });
  const summary = isAdmin && filters.summaryDate
    ? await getAdminAttendanceSummary(actor, { date: filters.summaryDate, employeeId: filters.employeeId, mode: filters.mode })
    : null;
  const exceptions = isAdmin && filters.summaryDate
    ? await getAdminAttendanceExceptions(actor, {
        date: filters.summaryDate,
        employeeId: filters.employeeId,
        mode: filters.mode,
        category: filters.exceptionCategory,
      })
    : null;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-[var(--blue)]">{actor.role === "SUPERVISOR" ? "Assigned attendance" : actor.role === "HR_ADMINISTRATOR" ? "HR attendance" : actor.role === "DEPARTMENT_MANAGER" ? "Department attendance" : "Administration"}</p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">{isAdmin ? "Attendance report" : "Direct attendance corrections"}</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">Direct corrections are limited to the employee attendance scope shown here and are recorded in audit history.</p>
      </div>

      <form method="get" className="grid gap-3 rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm sm:grid-cols-2 xl:grid-cols-4 xl:items-end">
        <label className="text-xs font-semibold text-[var(--muted)]">Employee
          <select name="employeeId" defaultValue={filters.employeeId} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]">
            <option value="">All employees</option>
            {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}{employee.employeeCode ? ` (${employee.employeeCode})` : ""}</option>)}
          </select>
        </label>
        {isAdmin && <label className="text-xs font-semibold text-[var(--muted)]">Selected local date
          <input name="summaryDate" type="date" defaultValue={filters.summaryDate} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]" />
        </label>}
        <label className="text-xs font-semibold text-[var(--muted)]">From local date
          <input name="from" type="date" defaultValue={filters.from} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]" />
        </label>
        <label className="text-xs font-semibold text-[var(--muted)]">To local date
          <input name="to" type="date" defaultValue={filters.to} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]" />
        </label>
        <label className="text-xs font-semibold text-[var(--muted)]">Work mode
          <select name="mode" defaultValue={filters.mode} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]"><option value="ALL">All modes</option><option value="OFFICE">Office</option><option value="WFH">WFH</option></select>
        </label>
        <label className="text-xs font-semibold text-[var(--muted)]">Session status
          <select name="status" defaultValue={filters.status} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]"><option value="ALL">All status</option><option value="ACTIVE">Active</option><option value="COMPLETED">Completed</option></select>
        </label>
        {isAdmin && <label className="text-xs font-semibold text-[var(--muted)]">Exception category
          <select name="exceptionCategory" defaultValue={filters.exceptionCategory} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]">
            <option value="ALL">All exceptions</option>
            <option value="LATE_ARRIVAL">Late arrivals</option>
            <option value="EARLY_DEPARTURE">Early departures</option>
            <option value="ACTIVE_SESSION">Currently open sessions</option>
            <option value="NO_ATTENDANCE">No attendance records</option>
          </select>
        </label>}
        {isAdmin && <label className="text-xs font-semibold text-[var(--muted)]">Data quality reason
          <select name="reviewReason" defaultValue={filters.reviewReason} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]">
            <option value="ALL">All review reasons</option>
            <option value="INVALID_IN_TIMESTAMP">Invalid IN timestamp</option>
            <option value="INVALID_OUT_TIMESTAMP">Invalid OUT timestamp</option>
            <option value="OUT_BEFORE_IN">OUT precedes IN</option>
            <option value="UNSAFE_DURATION">Unsafe duration</option>
          </select>
        </label>}
        <button type="submit" className="h-10 self-end rounded-md bg-[var(--action)] px-3.5 text-sm font-medium text-white hover:bg-[var(--action-hover)]">Apply filters</button>
      </form>
      {sessions.length === 500 && <p role="status" className="text-xs text-[var(--muted)]">The detailed session table is limited to the 500 most recent matches. Narrow the filters to inspect older sessions.</p>}

      {isAdmin && <section className="space-y-4" aria-labelledby="exceptions-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="exceptions-title" className="text-base font-semibold">Attendance exceptions</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">Counts are evaluated against each employee&apos;s local date and existing schedule.</p>
          </div>
          {exceptions && <p className="text-sm font-medium text-[var(--muted)]">{exceptions.date}</p>}
        </div>
        {exceptions ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Late arrivals", exceptions.metrics.lateArrivals],
                ["Early departures", exceptions.metrics.earlyDepartures],
                ["Currently open sessions", exceptions.metrics.activeSessions],
                ["No attendance records", exceptions.metrics.employeesWithoutAttendance],
              ].map(([label, value]) => (
                <div key={label} className="min-h-24 rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm">
                  <p className="text-xs font-medium text-[var(--muted)]">{label}</p>
                  <p className="mt-3 text-2xl font-semibold tabular-nums">{value}</p>
                </div>
              ))}
            </div>
            {exceptions.entries.length === 0 ? (
              <p role="status" className="rounded-lg border border-[var(--line)] bg-white px-4 py-5 text-sm text-[var(--muted)] shadow-sm">No attendance exceptions match these filters.</p>
            ) : (
              <ul className="space-y-3">
                {exceptions.entries.map((entry) => {
                  const selected = filters.employeeId === entry.employee.id;
                  return (
                    <li key={entry.employee.id}>
                      <article className="rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm sm:p-5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <Link href={exceptionEmployeeHref(filters, entry.employee.id)} className="text-sm font-semibold text-[var(--ink)] hover:text-[var(--blue)]">{entry.employee.name}</Link>
                            <p className="mt-1 text-xs text-[var(--muted)]">
                              {entry.employee.employeeCode ? `${entry.employee.employeeCode} · ` : ""}{entry.employee.countryCode} · {entry.employee.timeZone} · {exceptions.date}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {entry.categories.map((category) => (
                              <span key={category} className={`rounded-sm px-2 py-1 text-[11px] font-medium ${exceptionBadgeClasses[category]}`}>{exceptionLabels[category]}</span>
                            ))}
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--muted)]">
                          <span>{entry.day.sessions.length} session{entry.day.sessions.length === 1 ? "" : "s"} on selected date</span>
                          <span>Completed: {formatWorkedDuration(entry.day.totalWorkedMs)}</span>
                          {entry.openSessionCount > 0 && <span>{entry.openSessionCount} currently open</span>}
                          {selected ? (
                            <Link href={exceptionEmployeeHref(filters)} className="font-medium text-[var(--blue)] hover:underline">Back to all exceptions</Link>
                          ) : (
                            <Link href={exceptionEmployeeHref(filters, entry.employee.id)} className="font-medium text-[var(--blue)] hover:underline">Inspect attendance</Link>
                          )}
                        </div>
                        {selected && (
                          <div className="mt-4 border-t border-[var(--line)] pt-4">
                            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                              <div><h3 className="text-sm font-semibold">Sessions for {exceptions.date}</h3><p className="mt-1 text-xs text-[var(--muted)]">{entry.employee.countryCode} · {entry.employee.timeZone}</p></div>
                              <p className="text-xs text-[var(--muted)]">Completed worked time <span className="font-semibold text-[var(--ink)]">{formatWorkedDuration(entry.day.totalWorkedMs)}</span></p>
                            </div>
                            {entry.day.sessions.length === 0 ? (
                              <p className="rounded-md bg-slate-50 px-3 py-3 text-sm text-[var(--muted)]">No attendance records for this local date.</p>
                            ) : (
                              <ul className="space-y-2">
                                {entry.day.sessions.map((detail) => {
                                  const endAt = detail.session.endAt && Number.isFinite(detail.session.endAt.getTime()) ? detail.session.endAt : null;
                                  return (
                                    <li key={detail.session.id} className="rounded-md border border-[var(--line)] bg-white p-3">
                                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                        <span className={`rounded-sm px-2 py-1 text-[11px] font-medium ${sessionModeClass(detail.session.mode)}`}>{detail.session.mode === "WFH" ? "WFH" : "Office"}</span>
                                        <span className={`rounded-sm px-2 py-1 text-[11px] font-medium ${detail.status === "ACTIVE" ? "bg-[var(--mint)] text-[var(--mint-ink)]" : detail.status === "INVALID" ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-700"}`}>
                                          {detail.status === "ACTIVE" ? "Active / open" : detail.status === "COMPLETED" ? "Completed" : "Invalid data"}
                                        </span>
                                      </div>
                                      <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 xl:grid-cols-6">
                                        <div><AttendancePunch kind={detail.session.mode === "WFH" ? "WFH_IN" : "IN"}><p className="font-semibold">{formatInTimeZone(detail.session.startAt, entry.employee.timeZone, "MMM d, yyyy h:mm a")}</p><p className="mt-0.5 text-xs text-[var(--muted)]">{detail.timing?.arrival.replaceAll("_", " ") ?? "Unavailable"}</p></AttendancePunch></div>
                                        <div><AttendancePunch kind={detail.session.mode === "WFH" ? "WFH_OUT" : "OUT"}><p className="font-semibold">{endAt ? formatInTimeZone(endAt, entry.employee.timeZone, "MMM d, yyyy h:mm a") : detail.status === "ACTIVE" ? "Awaiting OUT" : "Unavailable"}</p><p className="mt-0.5 text-xs text-[var(--muted)]">{detail.timing?.departure?.replaceAll("_", " ") ?? (detail.status === "ACTIVE" ? "Session active" : "Timing unavailable")}</p></AttendancePunch></div>
                                        <div><dt className="text-[var(--muted)]">Completed duration</dt><dd className="mt-1 font-medium tabular-nums">{detail.status === "COMPLETED" ? formatWorkedDuration(detail.durationMs) : "—"}</dd></div>
                                        <div><dt className="text-[var(--muted)]">Arrival</dt><dd className="mt-1 font-medium">{detail.timing?.arrival.replaceAll("_", " ") ?? "Unavailable"}</dd></div>
                                        <div><dt className="text-[var(--muted)]">Departure</dt><dd className="mt-1 font-medium">{detail.timing?.departure?.replaceAll("_", " ") ?? "—"}</dd></div>
                                        <div><dt className="text-[var(--muted)]">Status</dt><dd className="mt-1 font-medium">{detail.status === "ACTIVE" ? "Active / open" : detail.status === "COMPLETED" ? "Completed" : "Invalid data"}</dd></div>
                                      </dl>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </div>
                        )}
                      </article>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : (
          <p className="rounded-lg border border-[var(--line)] bg-white px-4 py-5 text-sm text-[var(--muted)] shadow-sm">Choose a local date to review attendance exceptions.</p>
        )}
      </section>}

      <section className="space-y-4" aria-labelledby="data-quality-title">
        <div>
          <h2 id="data-quality-title" className="text-base font-semibold">Data quality review</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">Review sessions with timestamps or durations that cannot be evaluated safely. Open sessions remain in Attendance exceptions.</p>
        </div>
        {reviewItems.length === 0 ? (
          <p role="status" className="rounded-lg border border-[var(--line)] bg-white px-4 py-5 text-sm text-[var(--muted)] shadow-sm">No data quality records match these filters.</p>
        ) : (
          <ul className="space-y-3">
            {reviewItems.map(({ session, view }) => (
              <li key={session.id}>
                <article className="rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={exceptionEmployeeHref(filters, view.employee.id)} className="text-sm font-semibold text-[var(--ink)] hover:text-[var(--blue)]">{view.employee.name}</Link>
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        {view.employee.employeeCode ? `${view.employee.employeeCode} · ` : ""}{view.employee.countryCode} · {view.employee.timeZone} · {view.localDate}
                      </p>
                    </div>
                    <span className={`rounded-sm px-2 py-1 text-xs font-medium ${sessionModeClass(session.mode)}`}>{session.mode === "WFH" ? "WFH" : "Office"}</span>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3 xl:grid-cols-5">
                    <div><AttendancePunch kind={session.mode === "WFH" ? "WFH_IN" : "IN"}><p className="font-semibold">{view.correctionStart ? formatInTimeZone(session.startAt, view.employee.timeZone, "MMM d, yyyy h:mm a") : "Unavailable"}</p><p className="mt-0.5 text-xs text-[var(--muted)]">{view.arrival?.replaceAll("_", " ") ?? "Timing unavailable"}</p></AttendancePunch></div>
                    <div><AttendancePunch kind={session.mode === "WFH" ? "WFH_OUT" : "OUT"}><p className="font-semibold">{session.endAt === null ? "Awaiting OUT" : view.correctionEnd ? formatInTimeZone(session.endAt, view.employee.timeZone, "MMM d, yyyy h:mm a") : "Unavailable"}</p><p className="mt-0.5 text-xs text-[var(--muted)]">{view.departure?.replaceAll("_", " ") ?? (session.endAt === null ? "Session active" : "Timing unavailable")}</p></AttendancePunch></div>
                    <div><dt className="text-[var(--muted)]">Session status</dt><dd className="mt-1 font-medium">{view.status}</dd></div>
                    <div className="col-span-2 sm:col-span-1"><dt className="text-[var(--muted)]">Completed duration</dt><dd className="mt-1 font-medium tabular-nums">{view.reviewReasons.includes("UNSAFE_DURATION") ? "Unsafe to calculate" : formatWorkedDuration(view.durationMs)}</dd></div>
                    <div className="col-span-2 sm:col-span-3 xl:col-span-1"><dt className="text-[var(--muted)]">Review reason</dt><dd className="mt-1 flex flex-wrap gap-1.5">{view.reviewReasons.map((reason) => <span key={reason} className="rounded-sm bg-red-50 px-2 py-1 font-medium text-red-700">{reviewReasonLabels[reason]}</span>)}</dd></div>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
                    <Link href={exceptionEmployeeHref(filters, view.employee.id)} className="text-xs font-medium text-[var(--blue)] hover:underline">Inspect employee attendance</Link>
                    <AdminAttendanceCorrectionForm sessionId={session.id} localDate={view.localDate} timeZone={view.employee.timeZone} startAt={view.correctionStart} endAt={view.correctionEnd} mode={session.mode} />
                  </div>
                </article>
              </li>
            ))}
          </ul>
        )}
      </section>

      {summary && (
        <section className="space-y-4" aria-label="Selected date attendance dashboard">
          <div><h2 className="text-base font-semibold">Attendance for {summary.date}</h2><p className="mt-1 text-xs text-[var(--muted)]">Active employee accounts are considered. Date windows use each employee&apos;s timezone; employee and mode filters apply. Status filtering applies to the detailed session list.</p></div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {[
              ["Active employees considered", summary.metrics.totalEmployees],
              ["With attendance", summary.metrics.withAttendance],
              ["No attendance recorded", summary.metrics.withoutAttendance],
              ["Currently active", summary.metrics.activeNow],
              ["Late arrivals", summary.metrics.lateArrivals],
              ["Early departures", summary.metrics.earlyDepartures],
              ["With completed sessions", summary.metrics.completed],
            ].map(([label, value]) => (
              <div key={label} className="min-h-24 rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm">
                <p className="text-xs font-medium text-[var(--muted)]">{label}</p>
                <p className="mt-3 text-2xl font-semibold tabular-nums">{value}</p>
              </div>
            ))}
          </div>
          {summary.employees.length === 0 ? (
            <p className="rounded-lg border border-[var(--line)] bg-white px-4 py-5 text-sm text-[var(--muted)] shadow-sm">No active employee accounts match this selection.</p>
          ) : (
            <ul className="grid gap-3 xl:grid-cols-2">
              {summary.employees.map(({ employee, day, activeNow }) => (
                <li key={employee.id} className="rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div><p className="text-sm font-semibold">{employee.name} <span className="font-normal text-[var(--muted)]">{employee.employeeCode ? `· ${employee.employeeCode}` : ""}</span></p><p className="mt-1 text-xs text-[var(--muted)]">{employee.countryCode} · {employee.timeZone}</p></div>
                    <span className={`rounded-sm px-2 py-1 text-xs font-medium ${activeNow ? "bg-[var(--mint)] text-[var(--mint-ink)]" : day.sessions.length ? "bg-zinc-100 text-zinc-600" : "bg-[var(--amber)] text-[var(--amber-ink)]"}`}>{activeNow ? "Active now" : day.sessions.length ? "Recorded" : "No attendance"}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted)]"><span>{day.sessions.length} session{day.sessions.length === 1 ? "" : "s"}</span><span>Completed: {formatWorkedDuration(day.totalWorkedMs)}</span></div>
                  {day.sessions.map(({ session, timing, durationMs, status }) => (
                    <p key={session.id} className="mt-3 border-t border-[var(--line)] pt-3 text-xs leading-5 text-[var(--muted)]">
                      <span className="font-semibold text-[var(--ink)]">{session.mode === "WFH" ? "WFH" : "Office"}</span>{" · "}
                      {timing?.arrival.replaceAll("_", " ") ?? "Timing unavailable"}{" · "}
                      {timing?.departure?.replaceAll("_", " ") ?? (status === "ACTIVE" ? "Active session" : status === "INVALID" ? "Data unavailable" : "")}{" · "}
                      {formatWorkedDuration(durationMs)}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="space-y-3" aria-label="Daily employee attendance summaries">
        <div><h2 className="text-base font-semibold">Daily summaries</h2><p className="mt-1 text-xs text-[var(--muted)]">Totals include completed sessions only. Each day uses that employee&apos;s timezone.</p></div>
        {dailySummaries.length === 0 ? (
          <p className="rounded-lg border border-[var(--line)] bg-white px-4 py-5 text-sm text-[var(--muted)] shadow-sm">No daily summaries for these filters.</p>
        ) : (
          <ul className="grid gap-3 xl:grid-cols-2">
            {dailySummaries.map(({ employee, day }) => {
              const classifications = [...new Set(day.sessions.flatMap(({ timing }) => timing
                ? [timing.arrival, ...(timing.departure ? [timing.departure] : [])]
                : []))];
              const hasActiveSession = day.sessions.some(({ status }) => status === "ACTIVE");
              const completedSessionCount = day.sessions.filter(({ status }) => status === "COMPLETED").length;
              return (
                <li key={`${employee.id}-${day.date}`} className="rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div><p className="text-sm font-semibold">{employee.name} <span className="font-normal text-[var(--muted)]">{employee.employeeCode ? `· ${employee.employeeCode}` : ""}</span></p><p className="mt-1 text-xs text-[var(--muted)]">{day.date} · {employee.countryCode} · {employee.timeZone}</p></div>
                    <span className={`rounded-sm px-2 py-1 text-xs font-medium ${hasActiveSession ? "bg-[var(--mint)] text-[var(--mint-ink)]" : "bg-zinc-100 text-zinc-600"}`}>{hasActiveSession ? "Active session" : "No active session"}</span>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
                    <div><dt className="text-[var(--muted)]">Sessions</dt><dd className="mt-1 font-semibold">{day.sessions.length}</dd></div>
                    <div><dt className="text-[var(--muted)]">Completed worked time</dt><dd className="mt-1 font-semibold tabular-nums">{formatWorkedDuration(day.totalWorkedMs)}</dd></div>
                    <div className="col-span-2 sm:col-span-1"><dt className="text-[var(--muted)]">Schedule classifications</dt><dd className="mt-1 font-semibold">{classifications.length ? classifications.map((value) => value.replaceAll("_", " ")).join(" · ") : "Unavailable"}</dd></div>
                  </dl>
                  {completedSessionCount > 1 && <p role="status" className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">Historical conflict: {completedSessionCount} completed sessions exist on this employee-local day. Existing records are preserved and were not changed.</p>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-sm" aria-label="Employee attendance sessions">
        {sessions.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
            <span className="grid size-11 place-items-center rounded-full bg-slate-100 text-[var(--blue)]"><CalendarDays size={20} aria-hidden="true" /></span>
            <h2 className="mt-4 text-base font-semibold">No matching attendance sessions</h2>
            <p className="mt-2 text-sm text-[var(--muted)]">Try changing or clearing the filters.</p>
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[var(--line)] bg-zinc-50 text-xs text-[var(--muted)]">
                  <tr><th className="px-4 py-3.5 font-semibold">Employee</th><th className="px-4 py-3.5 font-semibold">Local date</th><th className="px-4 py-3.5 font-semibold">Mode</th><th className="px-4 py-3.5 font-semibold">IN</th><th className="px-4 py-3.5 font-semibold">OUT</th><th className="px-4 py-3.5 font-semibold">Duration</th><th className="px-4 py-3.5 font-semibold">Status</th><th className="px-4 py-3.5 font-semibold">Correction</th></tr>
                </thead>
                <tbody className="divide-y divide-[var(--line)]">
                  {sessions.map((session) => {
                    const view = sessionView(session);
                    return (
                      <tr key={session.id} className="align-top">
                        <td className="px-4 py-4"><p className="font-semibold">{view.employee.name}</p><p className="mt-1 text-xs text-[var(--muted)]">{view.employee.employeeCode ?? view.employee.email}</p></td>
                        <td className="px-4 py-4"><p>{view.localDate}</p><p className="mt-1 text-xs text-[var(--muted)]">{view.employee.countryCode} · {view.employee.timeZone}</p></td>
                        <td className="px-4 py-4"><span className={`rounded-md px-2 py-1 text-xs font-semibold ${sessionModeClass(session.mode)}`}>{session.mode === "WFH" ? "WFH" : "Office"}</span></td>
                        <td className="px-4 py-4"><AttendancePunch kind={session.mode === "WFH" ? "WFH_IN" : "IN"}><p className="font-semibold">{view.correctionStart ? formatInTimeZone(session.startAt, view.employee.timeZone, "MMM d, yyyy h:mm a") : "Invalid"}</p><p className="mt-0.5 text-xs text-[var(--muted)]">{view.arrival?.replaceAll("_", " ") ?? "Unavailable"}</p></AttendancePunch></td>
                        <td className="px-4 py-4"><AttendancePunch kind={session.mode === "WFH" ? "WFH_OUT" : "OUT"}><p className="font-semibold">{session.endAt && view.correctionEnd ? formatInTimeZone(session.endAt, view.employee.timeZone, "MMM d, yyyy h:mm a") : session.endAt ? "Invalid" : "Awaiting OUT"}</p><p className="mt-0.5 text-xs text-[var(--muted)]">{view.departure?.replaceAll("_", " ") ?? (session.endAt ? "Unavailable" : "Session active")}</p></AttendancePunch></td>
                        <td className="px-4 py-4 tabular-nums">{formatWorkedDuration(view.durationMs)}</td>
                        <td className="px-4 py-4"><span className={`text-xs font-semibold ${view.status === "Active" ? "text-[var(--mint-ink)]" : view.invalid ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>{view.status}</span></td>
                        <td className="px-4 py-4"><AdminAttendanceCorrectionForm sessionId={session.id} localDate={view.localDate} timeZone={view.employee.timeZone} startAt={view.correctionStart} endAt={view.correctionEnd} mode={session.mode} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-[var(--line)] lg:hidden">
              {sessions.map((session) => {
                const view = sessionView(session);
                return (
                  <li key={session.id} className="space-y-4 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-semibold">{view.employee.name}</p><p className="mt-1 text-xs text-[var(--muted)]">{view.employee.employeeCode ?? view.employee.email}</p></div><span className={`rounded-md px-2 py-1 text-xs font-semibold ${sessionModeClass(session.mode)}`}>{session.mode === "WFH" ? "WFH" : "Office"}</span></div>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div><p className="text-[var(--muted)]">Local date · {view.employee.countryCode} · {view.employee.timeZone}</p><p className="mt-1 font-medium">{view.localDate}</p></div>
                      <div><p className="text-[var(--muted)]">Status · duration</p><p className="mt-1 font-medium">{view.status} · {formatWorkedDuration(view.durationMs)}</p></div>
                      <div><AttendancePunch kind={session.mode === "WFH" ? "WFH_IN" : "IN"}><p className="font-semibold">{view.correctionStart ? formatInTimeZone(session.startAt, view.employee.timeZone, "MMM d, yyyy h:mm a") : "Invalid"}</p><p className="mt-0.5 text-xs text-[var(--muted)]">{view.arrival?.replaceAll("_", " ") ?? "Unavailable"}</p></AttendancePunch></div>
                      <div><AttendancePunch kind={session.mode === "WFH" ? "WFH_OUT" : "OUT"}><p className="font-semibold">{session.endAt && view.correctionEnd ? formatInTimeZone(session.endAt, view.employee.timeZone, "MMM d, yyyy h:mm a") : session.endAt ? "Invalid" : "Awaiting OUT"}</p><p className="mt-0.5 text-xs text-[var(--muted)]">{view.departure?.replaceAll("_", " ") ?? (session.endAt ? "Unavailable" : "Session active")}</p></AttendancePunch></div>
                    </div>
                    <AdminAttendanceCorrectionForm sessionId={session.id} localDate={view.localDate} timeZone={view.employee.timeZone} startAt={view.correctionStart} endAt={view.correctionEnd} mode={session.mode} />
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}