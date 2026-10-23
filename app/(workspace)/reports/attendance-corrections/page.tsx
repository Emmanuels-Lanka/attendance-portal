import { AttendanceCorrectionStatus } from "@prisma/client";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  attendanceCorrectionReportFiltersSchema,
  listAttendanceCorrectionReport,
} from "@/lib/attendance/correction-report";
import {
  correctionDisplayTimeZone,
  formatCorrectionCalendarDate,
  formatCorrectionJsonForDisplay,
  formatCorrectionTimestamp,
} from "@/lib/attendance/correction-display";
import { hasPermission } from "@/lib/auth/permissions";
import { requirePageUser } from "@/lib/auth/session";

type SearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

function reportHref(filters: {
  status: string;
  employeeId: string;
  from: string;
  to: string;
}, page: number) {
  const query = new URLSearchParams();
  if (filters.status !== "ALL") query.set("status", filters.status);
  if (filters.employeeId) query.set("employeeId", filters.employeeId);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (page > 1) query.set("page", String(page));
  const search = query.toString();
  return `/reports/attendance-corrections${search ? `?${search}` : ""}`;
}

export default async function AttendanceCorrectionReportPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requirePageUser();
  if (!hasPermission(actor.role, "reports:read")) redirect("/dashboard");
  const params = await searchParams;
  const filterResult = attendanceCorrectionReportFiltersSchema.safeParse({
    status: single(params.status) || "ALL",
    employeeId: single(params.employeeId),
    from: single(params.from),
    to: single(params.to),
    page: single(params.page) || "1",
  });

  if (!filterResult.success) {
    return (
      <div className="space-y-6">
        <header>
          <p className="text-sm font-medium text-[var(--blue)]">Reports</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Attendance correction report</h1>
        </header>
        <section role="alert" className="rounded-lg border border-red-200 bg-white p-5">
          <p className="text-sm text-red-800">{filterResult.error.issues[0]?.message ?? "The selected report filters are invalid."}</p>
          <Link href="/reports/attendance-corrections" className="mt-4 inline-flex h-10 items-center rounded-md border border-[var(--line)] px-4 text-sm font-medium">Clear filters</Link>
        </section>
      </div>
    );
  }

  const result = await listAttendanceCorrectionReport(actor, filterResult.data);
  const filters = result.filters;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium text-[var(--blue)]">Reports</p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Attendance correction report</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">Read-only history of persisted attendance correction requests and decisions.</p>
      </header>

      <form method="GET" className="grid gap-3 rounded-lg border border-[var(--line)] bg-white p-4 sm:grid-cols-2 xl:grid-cols-5 xl:items-end">
        <label className="text-xs font-semibold text-[var(--muted)]">Status
          <select name="status" defaultValue={filters.status} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]">
            {reportStatuses.map((status) => <option key={status} value={status}>{status === "ALL" ? "All statuses" : status.replaceAll("_", " ")}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-[var(--muted)]">Affected employee
          <select name="employeeId" defaultValue={filters.employeeId} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]">
            <option value="">All employees</option>
            {result.employees.map((employee) => (
              <option key={employee.id} value={employee.id}>{employee.name}{employee.employeeCode ? ` · ${employee.employeeCode}` : ""}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-semibold text-[var(--muted)]">Submitted from (UTC)
          <input type="date" name="from" defaultValue={filters.from} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] px-2.5 text-sm text-[var(--ink)]" />
        </label>
        <label className="text-xs font-semibold text-[var(--muted)]">Submitted through (UTC)
          <input type="date" name="to" defaultValue={filters.to} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] px-2.5 text-sm text-[var(--ink)]" />
        </label>
        <button type="submit" className="h-10 rounded-md bg-[var(--action)] px-4 text-sm font-medium text-white hover:bg-[var(--action-hover)]">Filter report</button>
      </form>

      {result.entries.length === 0 ? (
        <p role="status" className="rounded-lg border border-[var(--line)] bg-white px-4 py-8 text-sm text-[var(--muted)]">No attendance correction requests match these filters.</p>
      ) : (
        <ol className="space-y-4">
          {result.entries.map((entry) => {
            const timeZone = correctionDisplayTimeZone(entry.employee.timeZone);
            const attendanceDate = entry.attendanceDate
              ? entry.attendanceDate.toISOString().slice(0, 10)
              : entry.dailyAttendance
                ? entry.dailyAttendance.date.toISOString().slice(0, 10)
                : entry.session?.startAt
                  ? formatCorrectionCalendarDate(entry.session.startAt, timeZone)
                  : "unavailable";
            return (
            <li key={entry.id} className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm">
              <header className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">{entry.employee.name}</h2>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {entry.employee.employeeCode ?? "No employee ID"}
                    {" · Request "}
                    {entry.id}
                    {" · Submitted "}
                    {formatCorrectionTimestamp(entry.requestedAt, timeZone)}
                  </p>
                </div>
                <span className="rounded-sm bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">{entry.status.replaceAll("_", " ")}</span>
              </header>

              <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <div><dt className="text-xs font-semibold text-[var(--muted)]">Affected attendance date</dt><dd className="mt-1 text-sm">{attendanceDate}</dd></div>
                <div><dt className="text-xs font-semibold text-[var(--muted)]">Correction type</dt><dd className="mt-1 text-sm">{entry.sessionId ? `${entry.originalMode ?? "Unknown"} → ${entry.requestedMode ?? "Unknown"} session mode` : "Attendance time"}</dd></div>
                <div><dt className="text-xs font-semibold text-[var(--muted)]">Requester</dt><dd className="mt-1 text-sm">{entry.requester?.name ?? "Unavailable"}</dd></div>
                <div><dt className="text-xs font-semibold text-[var(--muted)]">Current approval stage</dt><dd className="mt-1 text-sm">{entry.currentApprovalStage ?? "None"}</dd></div>
                <div><dt className="text-xs font-semibold text-[var(--muted)]">Reviewer</dt><dd className="mt-1 text-sm">{entry.reviewedBy?.name ?? "—"}</dd></div>
                <div><dt className="text-xs font-semibold text-[var(--muted)]">Reviewed / decided</dt><dd className="mt-1 text-sm">{formatCorrectionTimestamp(entry.reviewedAt, timeZone)}</dd></div>
                <div><dt className="text-xs font-semibold text-[var(--muted)]">Resolved</dt><dd className="mt-1 text-sm">{formatCorrectionTimestamp(entry.resolvedAt, timeZone)}</dd></div>
                <div className="sm:col-span-2"><dt className="text-xs font-semibold text-[var(--muted)]">Request reason</dt><dd className="mt-1 whitespace-pre-wrap text-sm">{entry.reason}</dd></div>
                {entry.decisionNote && <div className="sm:col-span-2"><dt className="text-xs font-semibold text-[var(--muted)]">Decision note</dt><dd className="mt-1 whitespace-pre-wrap text-sm">{entry.decisionNote}</dd></div>}
                {entry.resolutionReason && <div className="sm:col-span-2"><dt className="text-xs font-semibold text-[var(--muted)]">Resolution reason</dt><dd className="mt-1 whitespace-pre-wrap text-sm">{entry.resolutionReason}</dd></div>}
              </dl>

              <div className="mt-4 grid gap-3 border-t border-[var(--line)] pt-4 md:grid-cols-2">
                <div><h3 className="text-xs font-semibold text-[var(--muted)]">Original values (display-formatted)</h3>
                  <p className="mt-1 text-[11px] text-[var(--muted)]">Instants shown in {timeZone}; stored evidence remains unchanged.</p>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 text-xs">{formatCorrectionJsonForDisplay(entry.originalValues, timeZone)}</pre>
                  {entry.originalStartAt && <p className="mt-2 text-xs">Original session start: {formatCorrectionTimestamp(entry.originalStartAt, timeZone)}</p>}
                  {entry.originalEndAt && <p className="mt-1 text-xs">Original session end: {formatCorrectionTimestamp(entry.originalEndAt, timeZone)}</p>}
                </div>
                <div><h3 className="text-xs font-semibold text-[var(--muted)]">Requested values (display-formatted)</h3>
                  <p className="mt-1 text-[11px] text-[var(--muted)]">Instants shown in {timeZone}; stored evidence remains unchanged.</p>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 text-xs">{formatCorrectionJsonForDisplay(entry.requestedValues, timeZone)}</pre>
                </div>
              </div>
              {entry.auditLogs.length > 0 && (
                <section aria-label="Approval audit history" className="mt-4 rounded-md border border-[var(--line)] bg-zinc-50 p-3">
                  <h3 className="text-xs font-semibold">Approval audit history</h3>
                  {entry.auditLogs.map((audit, index) => (
                    <div key={`${audit.createdAt.toISOString()}-${index}`} className="mt-2 text-sm">
                      <p>{audit.actionType.replaceAll("_", " ")} by {audit.actor?.name ?? "an unavailable reviewer"} at {formatCorrectionTimestamp(audit.createdAt, timeZone)}</p>
                      <p>Prior state: {formatCorrectionJsonForDisplay(audit.previousValues, timeZone)}</p>
                      <p>Result: {formatCorrectionJsonForDisplay(audit.newValues, timeZone)}</p>
                      <p>Recorded reason: {audit.reason ?? "Unavailable"}</p>
                    </div>
                  ))}
                </section>
              )}
            </li>
            );
          })}
        </ol>
      )}

      {result.pageCount > 1 && (
        <nav aria-label="Attendance correction report pages" className="flex items-center justify-between">
          <span className="text-sm text-[var(--muted)]">Page {result.page} of {result.pageCount} · {result.total} requests</span>
          <div className="flex gap-2">
            {result.page > 1 && <Link href={reportHref(filters, result.page - 1)} className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-zinc-50">Previous</Link>}
            {result.page < result.pageCount && <Link href={reportHref(filters, result.page + 1)} className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-zinc-50">Next</Link>}
          </div>
        </nav>
      )}
    </div>
  );
}

const reportStatuses = ["ALL", ...Object.values(AttendanceCorrectionStatus)] as const;
