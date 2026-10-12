import { formatInTimeZone } from "date-fns-tz";
import Link from "next/link";
import { formatWorkedDuration } from "@/lib/attendance/history";
import { getMonthlyAttendanceSummaryReport } from "@/lib/attendance/reports";
import { hasPermission } from "@/lib/auth/permissions";
import { requirePageUser } from "@/lib/auth/session";
import { redirect } from "next/navigation";

type SearchParams = { month?: string | string[]; employeeId?: string | string[] };

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

export default async function MonthlyAttendanceSummaryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePageUser();
  const canReadOrganization = hasPermission(user.role, "reports:read");
  const canReadDepartment = hasPermission(user.role, "reports:department:read");
  if (!canReadOrganization && !canReadDepartment) redirect("/dashboard");

  const params = await searchParams;
  const currentMonth = formatInTimeZone(new Date(), user.timeZone, "yyyy-MM");
  const requestedMonth = single(params.month);
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth);
  const month = validMonth ? requestedMonth : currentMonth;
  const selectedEmployeeId = single(params.employeeId).trim();
  const result = await getMonthlyAttendanceSummaryReport(user, month, selectedEmployeeId);
  const exportParams = new URLSearchParams({ month, ...(selectedEmployeeId ? { employeeId: selectedEmployeeId } : {}) }).toString();
  const overtimeByDepartment = new Map<string, {
    departmentId: string | null;
    departmentName: string;
    employees: number;
    pendingExpectedHours: number;
    pendingRequests: number;
    approvedExpectedHours: number;
    approvedRequests: number;
    rejectedExpectedHours: number;
    rejectedRequests: number;
    recordedActualHours: number;
    recordedActualDays: number;
    actualReportingEmployees: number;
    conflictingActualDays: number;
  }>();
  for (const { employee, report } of result.employees) {
    const departmentName = employee.departmentName ?? "Unassigned";
    const departmentKey = employee.departmentId ?? "unassigned";
    const current = overtimeByDepartment.get(departmentKey) ?? {
      departmentId: employee.departmentId,
      departmentName,
      employees: 0,
      pendingExpectedHours: 0,
      pendingRequests: 0,
      approvedExpectedHours: 0,
      approvedRequests: 0,
      rejectedExpectedHours: 0,
      rejectedRequests: 0,
      recordedActualHours: 0,
      recordedActualDays: 0,
      actualReportingEmployees: 0,
      conflictingActualDays: 0,
    };
    current.employees += 1;
    current.pendingExpectedHours += report.summary.pendingExpectedOvertimeHours ?? 0;
    current.pendingRequests += report.summary.pendingOvertimeRequestCount ?? 0;
    current.approvedExpectedHours += report.summary.approvedExpectedOvertimeHours ?? 0;
    current.approvedRequests += report.summary.approvedOvertimeRequestCount ?? 0;
    current.rejectedExpectedHours += report.summary.rejectedExpectedOvertimeHours ?? 0;
    current.rejectedRequests += report.summary.rejectedOvertimeRequestCount ?? 0;
    if (report.summary.recordedActualOvertimeHours !== null && report.summary.recordedActualOvertimeHours !== undefined) {
      current.recordedActualHours += report.summary.recordedActualOvertimeHours;
      current.actualReportingEmployees += 1;
    }
    current.recordedActualDays += report.summary.recordedActualOvertimeDays ?? 0;
    current.conflictingActualDays += report.summary.conflictingActualOvertimeDays ?? 0;
    overtimeByDepartment.set(departmentKey, current);
  }
  const departmentOvertimeRows = [...overtimeByDepartment.values()].sort((left, right) => left.departmentName.localeCompare(right.departmentName) || (left.departmentId ?? "").localeCompare(right.departmentId ?? ""));
  const summaryMetrics = [
    { label: "Employees", value: result.summary.employeeCount },
    { label: "Scheduled workdays", value: result.summary.totalWorkingDays ?? "Unavailable" },
    { label: "Present", value: result.summary.presentDays ?? "Not calculated" },
    { label: "Late arrivals", value: result.summary.lateDays ?? "Not calculated" },
    { label: "Early departures", value: result.summary.earlyOutDays ?? "Not calculated" },
    { label: "Approved leave", value: result.summary.approvedLeaveDays ?? "Unavailable" },
    { label: "WFH days", value: result.summary.workFromHomeDays },
    { label: "Holidays", value: result.summary.holidayDays },
    { label: "Absent", value: result.summary.absentDays ?? "Not calculated" },
    { label: "Missing punch", value: result.summary.missingPunchDays },
    { label: "Weekend", value: result.summary.weekendDays },
    { label: "Undetermined", value: result.summary.undeterminedDays },
    { label: "Calculated dates", value: result.summary.totalCalculatedDays },
    { label: "Session time", value: formatWorkedDuration(result.summary.totalWorkedMs) },
    { label: "Engine-calculated hours", value: result.summary.engineWorkedMs === null ? "Not calculated" : formatWorkedDuration(result.summary.engineWorkedMs) },
    { label: "Approved OT request estimate", value: `${result.summary.approvedExpectedHours.toFixed(2)} h · ${result.summary.approvedRequestCount} requests` },
    { label: "Pending OT request estimate", value: `${result.summary.pendingExpectedHours.toFixed(2)} h · ${result.summary.pendingRequestCount} requests` },
    { label: "Rejected OT request estimate", value: `${result.summary.rejectedExpectedHours.toFixed(2)} h · ${result.summary.rejectedRequestCount} requests` },
    { label: "Recorded actual OT", value: result.summary.recordedActualHours === null ? "Not recorded" : `${result.summary.recordedActualHours.toFixed(2)} h` },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[var(--blue)]">Attendance reports</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Monthly attendance summary</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">{canReadOrganization ? "Organization summary" : "Department summary"} for {month}; totals count employee-days.</p>
        </div>
        <form method="get" className="grid w-full gap-2 sm:w-auto sm:grid-cols-[minmax(150px,auto)_minmax(200px,1fr)_auto] sm:items-end">
          <label htmlFor="monthly-summary-month" className="text-xs font-semibold text-[var(--muted)]">Month
            <input id="monthly-summary-month" type="month" name="month" defaultValue={month} className="mt-1 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm text-[var(--ink)]" />
          </label>
          <label htmlFor="monthly-summary-employee" className="text-xs font-semibold text-[var(--muted)]">Employee
            <select id="monthly-summary-employee" name="employeeId" defaultValue={selectedEmployeeId} className="mt-1 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm text-[var(--ink)]">
              <option value="">All authorized employees</option>
              {result.availableEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}{employee.employeeCode ? ` (${employee.employeeCode})` : ""}</option>)}
            </select>
          </label>
          <button type="submit" className="h-10 rounded-md bg-[var(--action)] px-4 text-sm font-semibold text-white hover:bg-[var(--action-hover)]">Apply</button>
        </form>
        <div className="flex flex-wrap gap-2">
          <Link href={`/reports/monthly/export?${exportParams}&format=pdf`} className="inline-flex h-10 items-center rounded-md border border-[var(--line)] bg-white px-3 text-sm font-medium hover:bg-zinc-50">PDF</Link>
          <Link href={`/reports/monthly/export?${exportParams}&format=xlsx`} className="inline-flex h-10 items-center rounded-md border border-[var(--line)] bg-white px-3 text-sm font-medium hover:bg-zinc-50">Excel</Link>
          <Link href={`/reports/monthly/export?${exportParams}&format=csv`} className="inline-flex h-10 items-center rounded-md border border-[var(--line)] bg-white px-3 text-sm font-medium hover:bg-zinc-50">CSV</Link>
        </div>
      </div>

      {requestedMonth && !validMonth && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Invalid month. Showing the current month instead.</p>}

      <section aria-labelledby="management-month-summary" className="space-y-3">
        <h2 id="management-month-summary" className="text-base font-semibold">Summary totals</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {summaryMetrics.map(({ label, value }) => <div key={label} className="min-h-24 rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm"><p className="text-xs font-medium text-[var(--muted)]">{label}</p><p className="mt-3 text-xl font-semibold tabular-nums">{value}</p></div>)}
        </div>
        {result.summary.recordedActualHours === null
          ? <p role="note" className="text-xs text-[var(--muted)]">Actual OT is not recorded; request estimates are not treated as worked overtime.</p>
          : <p role="note" className="text-xs text-[var(--muted)]">Recorded actual OT covers {result.summary.recordedActualEmployees} employees and {result.summary.recordedActualDays} employee-days; conflicting daily values are excluded.</p>}
        {result.summary.absentDays === null && <p role="note" className="text-xs text-[var(--muted)]">Absence is shown only when an ABSENT status has been explicitly saved; missing attendance is not automatically classified as absence.</p>}
        {result.summary.totalCalculatedDays > 0 && <p className="text-xs text-[var(--muted)]">Status totals cover {result.summary.totalCalculatedDays} employee-dates with saved or on-demand engine results.</p>}
        {result.summary.engineCalculatedDays > 0 && <p className="text-xs text-[var(--muted)]">Engine hours cover {result.summary.engineCalculatedDays} date{result.summary.engineCalculatedDays === 1 ? "" : "s"} with saved daily calculations.</p>}
        <p role="note" className="text-xs text-[var(--muted)]">Approved, pending, and rejected OT values are request estimates. Recorded actual OT is read only from AttendanceDaily.overtimeHours; the engine currently does not calculate it.</p>
      </section>

      <section aria-labelledby="overtime-department-title" className="space-y-3">
        <div><h2 id="overtime-department-title" className="text-base font-semibold">Overtime by department</h2><p className="mt-1 text-xs text-[var(--muted)]">Request estimates and explicitly recorded actual hours are kept separate.</p></div>
        {departmentOvertimeRows.length === 0 ? (
          <p role="status" className="rounded-lg border border-[var(--line)] bg-white px-4 py-6 text-sm text-[var(--muted)]">No department overtime records are available for this scope.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-[var(--line)] bg-white">
            <table className="w-full min-w-[940px] text-left text-sm">
              <thead className="border-b border-[var(--line)] bg-zinc-50 text-xs text-[var(--muted)]"><tr><th className="px-4 py-3 font-semibold">Department</th><th className="px-4 py-3 font-semibold">Employees</th><th className="px-4 py-3 font-semibold">Pending estimate</th><th className="px-4 py-3 font-semibold">Approved estimate</th><th className="px-4 py-3 font-semibold">Rejected estimate</th><th className="px-4 py-3 font-semibold">Recorded actual</th><th className="px-4 py-3 font-semibold">Actual days</th><th className="px-4 py-3 font-semibold">Conflicting days</th></tr></thead>
              <tbody className="divide-y divide-[var(--line)]">{departmentOvertimeRows.map((department) => <tr key={department.departmentName}>
                <td className="px-4 py-3 font-medium">{department.departmentName}</td>
                <td className="px-4 py-3 tabular-nums">{department.employees}</td>
                <td className="px-4 py-3 tabular-nums">{department.pendingExpectedHours.toFixed(2)} h<span className="mt-0.5 block text-xs text-[var(--muted)]">{department.pendingRequests} requests</span></td>
                <td className="px-4 py-3 tabular-nums">{department.approvedExpectedHours.toFixed(2)} h<span className="mt-0.5 block text-xs text-[var(--muted)]">{department.approvedRequests} requests</span></td>
                <td className="px-4 py-3 tabular-nums">{department.rejectedExpectedHours.toFixed(2)} h<span className="mt-0.5 block text-xs text-[var(--muted)]">{department.rejectedRequests} requests</span></td>
                <td className="px-4 py-3 tabular-nums">{department.actualReportingEmployees ? `${department.recordedActualHours.toFixed(2)} h` : "Not recorded"}<span className="mt-0.5 block text-xs text-[var(--muted)]">{department.actualReportingEmployees} employees with recorded values</span></td>
                <td className="px-4 py-3 tabular-nums">{department.recordedActualDays}</td>
                <td className="px-4 py-3 tabular-nums">{department.conflictingActualDays}</td>
              </tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      {result.employees.length === 0 ? (
        <section className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-[var(--line)] bg-white px-6 text-center">
          <h2 className="text-base font-semibold">No employees in this report scope</h2>
          <p role="status" className="mt-2 max-w-md text-sm text-[var(--muted)]">No linked employees are available for the selected organization or department.</p>
        </section>
      ) : (
        <section aria-labelledby="monthly-summary-employee-list" className="overflow-hidden rounded-lg border border-[var(--line)] bg-white">
          <header className="border-b border-[var(--line)] px-4 py-3"><h2 id="monthly-summary-employee-list" className="text-base font-semibold">Employee summaries</h2></header>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[2020px] text-left text-sm">
              <thead className="border-b border-[var(--line)] bg-zinc-50 text-xs text-[var(--muted)]"><tr><th className="px-4 py-3 font-semibold">Employee</th><th className="px-4 py-3 font-semibold">Department</th><th className="px-4 py-3 font-semibold">Workdays</th><th className="px-4 py-3 font-semibold">Present</th><th className="px-4 py-3 font-semibold">Late</th><th className="px-4 py-3 font-semibold">Early out</th><th className="px-4 py-3 font-semibold">Leave</th><th className="px-4 py-3 font-semibold">WFH</th><th className="px-4 py-3 font-semibold">Holidays</th><th className="px-4 py-3 font-semibold">Absent</th><th className="px-4 py-3 font-semibold">Missing punch</th><th className="px-4 py-3 font-semibold">Weekend</th><th className="px-4 py-3 font-semibold">Undetermined</th><th className="px-4 py-3 font-semibold">Session time</th><th className="px-4 py-3 font-semibold">Engine hours</th><th className="px-4 py-3 font-semibold">Pending OT estimate</th><th className="px-4 py-3 font-semibold">Approved OT estimate</th><th className="px-4 py-3 font-semibold">Rejected OT estimate</th><th className="px-4 py-3 font-semibold">Recorded actual OT</th></tr></thead>
              <tbody className="divide-y divide-[var(--line)]">{result.employees.map(({ employee, report }) => <tr key={employee.id}>
                <td className="px-4 py-3 font-medium">{employee.name}{employee.employeeCode && <span className="mt-0.5 block text-xs text-[var(--muted)]">{employee.employeeCode}</span>}</td>
                <td className="px-4 py-3 text-[var(--muted)]">{employee.departmentName ?? "—"}</td>
                <td className="px-4 py-3 tabular-nums">{report.summary.totalWorkingDays ?? "—"}</td>
                <td className="px-4 py-3 tabular-nums">{report.summary.presentDays ?? "—"}</td>
                <td className="px-4 py-3 tabular-nums">{report.summary.lateDays ?? "—"}</td>
                <td className="px-4 py-3 tabular-nums">{report.summary.earlyOutDays ?? "—"}</td>
                <td className="px-4 py-3 tabular-nums">{report.summary.approvedLeaveDays ?? "—"}</td>
                <td className="px-4 py-3 tabular-nums">{report.summary.workFromHomeDays ?? 0}</td>
                <td className="px-4 py-3 tabular-nums">{report.summary.holidayDays ?? 0}</td>
                <td className="px-4 py-3 tabular-nums">{report.summary.absentDays ?? "—"}</td>
                <td className="px-4 py-3 tabular-nums">{report.summary.missingPunchDays ?? "—"}</td>
                <td className="px-4 py-3 tabular-nums">{report.summary.weekendDays ?? "—"}</td>
                <td className="px-4 py-3 tabular-nums">{report.summary.undeterminedDays ?? "—"}</td>
                <td className="px-4 py-3 tabular-nums">{formatWorkedDuration(report.summary.totalWorkedMs)}</td>
                <td className="px-4 py-3 tabular-nums">{report.summary.engineWorkedMs == null ? "—" : formatWorkedDuration(report.summary.engineWorkedMs)}<span className="mt-0.5 block text-xs text-[var(--muted)]">{report.summary.engineCalculatedDays ?? 0} calculated days</span></td>
                <td className="px-4 py-3 tabular-nums">{(report.summary.pendingExpectedOvertimeHours ?? 0).toFixed(2)} h <span className="block text-xs text-[var(--muted)]">{report.summary.pendingOvertimeRequestCount ?? 0} requests</span></td>
                <td className="px-4 py-3 tabular-nums">{(report.summary.approvedExpectedOvertimeHours ?? 0).toFixed(2)} h <span className="block text-xs text-[var(--muted)]">{report.summary.approvedOvertimeRequestCount ?? 0} requests</span></td>
                <td className="px-4 py-3 tabular-nums">{(report.summary.rejectedExpectedOvertimeHours ?? 0).toFixed(2)} h <span className="block text-xs text-[var(--muted)]">{report.summary.rejectedOvertimeRequestCount ?? 0} requests</span></td>
                <td className="px-4 py-3 tabular-nums">{report.summary.recordedActualOvertimeHours == null ? "—" : `${report.summary.recordedActualOvertimeHours.toFixed(2)} h`}<span className="block text-xs text-[var(--muted)]">{report.summary.recordedActualOvertimeDays ?? 0} days{report.summary.conflictingActualOvertimeDays ? ` · ${report.summary.conflictingActualOvertimeDays} conflicts` : ""}</span></td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}