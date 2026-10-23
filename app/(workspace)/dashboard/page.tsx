import { ArrowUpRight } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import Link from "next/link";
import { AttendanceToday } from "@/components/attendance-today";
import { HrSelfAttendance } from "@/components/hr-self-attendance";
import { hasPermission } from "@/lib/auth/permissions";
import { getAdminAttendanceSummary } from "@/lib/attendance/admin-dashboard";
import { listCalculatedDailyAttendance } from "@/lib/attendance/daily-read";
import { listDailyAttendanceCorrections } from "@/lib/attendance/correction-service";
import { formatWorkedDuration } from "@/lib/attendance/history";
import { getEmployeeMonthlyReport, getMonthlyAttendanceSummaryReport } from "@/lib/attendance/reports";
import { getEmployeeAttendanceDashboard } from "@/lib/attendance/service";
import { requirePageUser } from "@/lib/auth/session";
import { listManagerLeaveRequests, listSupervisorLeaveRequests } from "@/lib/leave/approval-service";
import { listOvertimeRequestsForReview } from "@/lib/overtime/service";
import { listWorkFromHomeRequestsForReview } from "@/lib/wfh/service";

type PendingApprovalLink = { label: string; href: string; count: number };

function ManagerDashboard({
  roleLabel,
  date,
  metrics,
  pendingApprovals,
  reportHref,
}: {
  roleLabel: string;
  date: string;
  metrics: Array<{ label: string; value: number | string; href?: string }>;
  pendingApprovals: PendingApprovalLink[];
  reportHref?: string;
}) {
  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[var(--blue)]">{roleLabel} workspace</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Attendance and approvals</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">Attendance is limited to employees assigned to your department or Supervisor relationship.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/attendance/daily" className="inline-flex h-10 items-center rounded-md bg-[var(--action)] px-4 text-sm font-semibold text-white hover:bg-[var(--action-hover)]">Team attendance</Link>
          {reportHref && <Link href={reportHref} className="inline-flex h-10 items-center rounded-md border border-[var(--line)] bg-white px-4 text-sm font-semibold text-[var(--ink)] hover:bg-zinc-50">Department report</Link>}
          <Link href="/notifications" className="inline-flex h-10 items-center rounded-md border border-[var(--line)] bg-white px-4 text-sm font-semibold text-[var(--ink)] hover:bg-zinc-50">Notifications</Link>
        </div>
      </header>

      <section aria-labelledby="team-attendance-title" className="space-y-3">
        <div><h2 id="team-attendance-title" className="text-base font-semibold">Attendance · {date}</h2><p className="mt-1 text-xs text-[var(--muted)]">No session recorded is not treated as an absence. Absent and missing-punch counts include only stored calculated statuses.</p></div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {metrics.map(({ label, value, href }) => href ? (
            <Link key={label} href={href} className="min-h-24 rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm transition hover:border-slate-300 hover:bg-zinc-50">
              <p className="text-xs font-medium text-[var(--muted)]">{label}</p><p className="mt-3 text-xl font-semibold tabular-nums">{value}</p>
            </Link>
          ) : (
            <div key={label} className="min-h-24 rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm"><p className="text-xs font-medium text-[var(--muted)]">{label}</p><p className="mt-3 text-xl font-semibold tabular-nums">{value}</p></div>
          ))}
        </div>
      </section>

      <section aria-labelledby="pending-approvals-title" className="space-y-3">
        <div><h2 id="pending-approvals-title" className="text-base font-semibold">Pending approvals</h2><p className="mt-1 text-xs text-[var(--muted)]">Counts reflect requests currently assigned to your approval stage.</p></div>
        {pendingApprovals.length === 0 ? (
          <p role="status" className="rounded-lg border border-[var(--line)] bg-white px-4 py-6 text-sm text-[var(--muted)]">No requests are awaiting your review.</p>
        ) : (
          <ul className="divide-y divide-[var(--line)] rounded-lg border border-[var(--line)] bg-white">
            {pendingApprovals.map(({ label, href, count }) => (
              <li key={href} className="flex items-center justify-between gap-4 px-4 py-3">
                <Link href={href} className="text-sm font-medium text-[var(--blue)] hover:underline">{label}</Link>
                <span className="text-sm font-semibold tabular-nums">{count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default async function DashboardPage() {
  const user = await requirePageUser();
  const currentMonth = formatInTimeZone(new Date(), user.timeZone, "yyyy-MM");

  if (user.role === "HR_ADMINISTRATOR") {
    const today = formatInTimeZone(new Date(), user.timeZone, "yyyy-MM-dd");
    const [todaySummary, monthlyReport, personalAttendance] = await Promise.all([
      getAdminAttendanceSummary(user, { date: today }),
      getMonthlyAttendanceSummaryReport(user, currentMonth),
      getEmployeeAttendanceDashboard(user),
    ]);
    const employeesWithWfh = todaySummary.employees.filter(({ day }) => day.sessions.some(({ session }) => session.mode === "WFH")).length;
    const departmentMetrics = new Map<string, {
      departmentName: string;
      employeeCount: number;
      presentDays: number | null;
      lateDays: number | null;
      wfhDays: number;
    }>();
    for (const { employee, report } of monthlyReport.employees) {
      const departmentKey = employee.departmentId ?? "unassigned";
      const department = departmentMetrics.get(departmentKey) ?? {
        departmentName: employee.departmentName ?? "Unassigned",
        employeeCount: 0,
        presentDays: null,
        lateDays: null,
        wfhDays: 0,
      };
      department.employeeCount += 1;
      department.wfhDays += report.summary.workFromHomeDays ?? 0;
      if ((report.summary.totalCalculatedDays ?? 0) > 0) {
        department.presentDays = (department.presentDays ?? 0) + (report.summary.presentDays ?? 0);
        department.lateDays = (department.lateDays ?? 0) + (report.summary.lateDays ?? 0);
      }
      departmentMetrics.set(departmentKey, department);
    }
    const departments = [...departmentMetrics.values()].sort((left, right) => left.departmentName.localeCompare(right.departmentName));
    const todayMetrics = [
      { label: "Active employees", value: todaySummary.metrics.totalEmployees },
      { label: "With attendance", value: todaySummary.metrics.withAttendance },
      { label: "Late arrivals", value: todaySummary.metrics.lateArrivals },
      { label: "Early departures", value: todaySummary.metrics.earlyDepartures },
      { label: "WFH sessions", value: employeesWithWfh },
      { label: "Open sessions", value: todaySummary.metrics.activeNow },
      { label: "No session recorded", value: todaySummary.metrics.withoutAttendance },
    ];
    const monthlyMetrics = [
      { label: "Employees", value: monthlyReport.summary.employeeCount },
      { label: "Present days", value: monthlyReport.summary.presentDays ?? "Not calculated" },
      { label: "Late days", value: monthlyReport.summary.lateDays ?? "Not calculated" },
      { label: "Absence", value: monthlyReport.summary.absentDays ?? "Not recorded" },
      { label: "Approved leave days", value: monthlyReport.summary.approvedLeaveDays ?? "Unavailable" },
      { label: "WFH days", value: monthlyReport.summary.workFromHomeDays },
      { label: "Engine hours", value: monthlyReport.summary.engineWorkedMs == null ? "Not calculated" : formatWorkedDuration(monthlyReport.summary.engineWorkedMs) },
      { label: "Approved OT estimate", value: `${monthlyReport.summary.approvedExpectedHours.toFixed(2)} h` },
    ];

    return (
      <div className="space-y-7">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-[var(--blue)]">HR workspace</p>
            <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Attendance overview</h1>
            <p className="mt-2 text-sm text-[var(--muted)]">Today&apos;s employee sessions and this month&apos;s saved attendance calculations.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/attendance/daily" className="inline-flex h-10 items-center rounded-md bg-[var(--action)] px-4 text-sm font-semibold text-white hover:bg-[var(--action-hover)]">Daily attendance</Link>
            <Link href="/reports/monthly" className="inline-flex h-10 items-center rounded-md border border-[var(--line)] bg-white px-4 text-sm font-semibold text-[var(--ink)] hover:bg-zinc-50">Monthly report</Link>
            <Link href="/approvals/attendance-corrections" className="inline-flex h-10 items-center rounded-md border border-[var(--line)] bg-white px-4 text-sm font-semibold text-[var(--ink)] hover:bg-zinc-50">Correction approvals</Link>
          </div>
        </header>

        <section aria-labelledby="today-attendance-title" className="space-y-3">
          <div><h2 id="today-attendance-title" className="text-base font-semibold">Today · {today}</h2><p className="mt-1 text-xs text-[var(--muted)]">Session counts use each employee&apos;s local day. No-session employees are not automatically classified as absent.</p></div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {todayMetrics.map(({ label, value }) => <div key={label} className="min-h-24 rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm"><p className="text-xs font-medium text-[var(--muted)]">{label}</p><p className="mt-3 text-xl font-semibold tabular-nums">{value}</p></div>)}
          </div>
        </section>

        <HrSelfAttendance
          employeeRecordFound={personalAttendance.employeeRecordFound}
          controls={
            <AttendanceToday
              activeSession={personalAttendance.activeSession}
              previousDayActiveSession={personalAttendance.previousDayActiveSession}
              activeSessionTiming={personalAttendance.activeSessionTiming}
              previousDayActiveSessionTiming={personalAttendance.previousDayActiveSessionTiming}
              day={personalAttendance.day}
              attendanceDate={personalAttendance.date}
              timeZone={user.timeZone}
              invalidSessions={personalAttendance.invalidSessions}
              completedSessionToday={personalAttendance.completedSessionToday}
            />
          }
        />

        <section aria-labelledby="month-attendance-title" className="space-y-3">
          <div><h2 id="month-attendance-title" className="text-base font-semibold">Month to date · {currentMonth}</h2><p className="mt-1 text-xs text-[var(--muted)]">Absences are reported only when an ABSENT status has been explicitly saved.</p></div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {monthlyMetrics.map(({ label, value }) => <div key={label} className="min-h-24 rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm"><p className="text-xs font-medium text-[var(--muted)]">{label}</p><p className="mt-3 text-xl font-semibold tabular-nums">{value}</p></div>)}
          </div>
        </section>

        <section aria-labelledby="department-attendance-title" className="space-y-3">
          <div><h2 id="department-attendance-title" className="text-base font-semibold">Department attendance · {currentMonth}</h2><p className="mt-1 text-xs text-[var(--muted)]">Employee-day totals are based on the same authorized monthly summary.</p></div>
          {departments.length === 0 ? (
            <p role="status" className="rounded-lg border border-[var(--line)] bg-white px-4 py-6 text-sm text-[var(--muted)]">No employee attendance is available for this month.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-[var(--line)] bg-white">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-[var(--line)] bg-zinc-50 text-xs text-[var(--muted)]"><tr><th className="px-4 py-3 font-semibold">Department</th><th className="px-4 py-3 font-semibold">Employees</th><th className="px-4 py-3 font-semibold">Present days</th><th className="px-4 py-3 font-semibold">Late days</th><th className="px-4 py-3 font-semibold">WFH days</th></tr></thead>
                <tbody className="divide-y divide-[var(--line)]">{departments.map((department) => <tr key={department.departmentName}><td className="px-4 py-3 font-medium">{department.departmentName}</td><td className="px-4 py-3 tabular-nums">{department.employeeCount}</td><td className="px-4 py-3 tabular-nums">{department.presentDays ?? "Not calculated"}</td><td className="px-4 py-3 tabular-nums">{department.lateDays ?? "Not calculated"}</td><td className="px-4 py-3 tabular-nums">{department.wfhDays}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    );
  }

  if (user.role === "DEPARTMENT_MANAGER" || user.role === "SUPERVISOR") {
    const today = formatInTimeZone(new Date(), user.timeZone, "yyyy-MM-dd");
    const todaySummaryPromise = getAdminAttendanceSummary(user, { date: today });
    const overtimePromise = listOvertimeRequestsForReview(user);
    const workFromHomePromise = listWorkFromHomeRequestsForReview(user);

    if (user.role === "DEPARTMENT_MANAGER") {
      const [todaySummary, absentRows, monthlyReport, leaveRequests, overtimeRequests, workFromHomeRequests] = await Promise.all([
        todaySummaryPromise,
        listCalculatedDailyAttendance(user, { date: today, status: "ABSENT" }),
        getMonthlyAttendanceSummaryReport(user, currentMonth),
        listManagerLeaveRequests(user),
        overtimePromise,
        workFromHomePromise,
      ]);
      const employeesWithWfh = todaySummary.employees.filter(({ day }) => day.sessions.some(({ session }) => session.mode === "WFH")).length;
      const pendingApprovals = [
        { label: "Leave", href: "/approvals/leave", count: leaveRequests.length },
        { label: "Overtime", href: "/approvals/overtime", count: overtimeRequests.length },
        { label: "Work from home", href: "/approvals/wfh", count: workFromHomeRequests.length },
      ];
      return (
        <ManagerDashboard
          roleLabel="Department Manager"
          date={today}
          reportHref="/reports/monthly"
          metrics={[
            { label: "Department employees", value: todaySummary.metrics.totalEmployees },
            { label: "Late arrivals", value: todaySummary.metrics.lateArrivals, href: `/admin/attendance/daily?date=${today}&status=LATE` },
            { label: "Early departures", value: todaySummary.metrics.earlyDepartures },
            { label: "Recorded absent", value: absentRows.total, href: `/admin/attendance/daily?date=${today}&status=ABSENT` },
            { label: "WFH sessions", value: employeesWithWfh },
            { label: "No session recorded", value: todaySummary.metrics.withoutAttendance },
            { label: "Present days this month", value: monthlyReport.summary.presentDays ?? "Not calculated" },
            { label: "Late days this month", value: monthlyReport.summary.lateDays ?? "Not calculated" },
          ]}
          pendingApprovals={pendingApprovals}
        />
      );
    }

    const [todaySummary, missingPunchRows, leaveRequests, overtimeRequests, workFromHomeRequests, corrections] = await Promise.all([
      todaySummaryPromise,
      listCalculatedDailyAttendance(user, { date: today, status: "MISSING_PUNCH" }),
      listSupervisorLeaveRequests(user),
      overtimePromise,
      workFromHomePromise,
      listDailyAttendanceCorrections(user),
    ]);
    const pendingApprovals = [
      { label: "Leave", href: "/approvals/leave", count: leaveRequests.length },
      { label: "Overtime", href: "/approvals/overtime", count: overtimeRequests.length },
      { label: "Work from home", href: "/approvals/wfh", count: workFromHomeRequests.length },
      { label: "Attendance corrections", href: "/approvals/attendance-corrections", count: corrections.length },
    ];
    return (
      <ManagerDashboard
        roleLabel="Supervisor"
        date={today}
        metrics={[
          { label: "Assigned employees", value: todaySummary.metrics.totalEmployees },
          { label: "Late arrivals", value: todaySummary.metrics.lateArrivals, href: `/admin/attendance/daily?date=${today}&status=LATE` },
          { label: "Early departures", value: todaySummary.metrics.earlyDepartures },
          { label: "Recorded missing punches", value: missingPunchRows.total, href: `/admin/attendance/daily?date=${today}&status=MISSING_PUNCH` },
          { label: "No session recorded", value: todaySummary.metrics.withoutAttendance },
        ]}
        pendingApprovals={pendingApprovals}
      />
    );
  }

  const {
    date,
    activeSession,
    previousDayActiveSession,
    activeSessionTiming,
    previousDayActiveSessionTiming,
    day,
    completedSessionToday,
    invalidSessions,
  } = await getEmployeeAttendanceDashboard(user);
  const monthlyReport = await getEmployeeMonthlyReport(user, currentMonth);
  const thisMonthMetrics = [
    { label: "Present", value: monthlyReport.summary.presentDays ?? "Not calculated" },
    { label: "Late arrivals", value: monthlyReport.summary.lateDays ?? "Not calculated" },
    { label: "Approved leave", value: monthlyReport.summary.approvedLeaveDays ?? "Unavailable" },
    { label: "WFH days", value: monthlyReport.summary.workFromHomeDays ?? 0 },
    { label: "Holidays", value: monthlyReport.summary.holidayDays ?? 0 },
    { label: "Absent", value: monthlyReport.summary.absentDays ?? "Not calculated" },
    { label: "Session time", value: formatWorkedDuration(monthlyReport.summary.totalWorkedMs) },
    { label: "Engine hours", value: monthlyReport.summary.engineWorkedMs == null ? "Not calculated" : `${formatWorkedDuration(monthlyReport.summary.engineWorkedMs)} · ${monthlyReport.summary.engineCalculatedDays ?? 0} days` },
  ];

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[var(--blue)]">Employee workspace</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Good to see you, {user.name.split(" ")[0]}</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">Your attendance at a glance.</p>
        </div>
        <Link href="/attendance" className="inline-flex h-10 items-center gap-2 rounded-md border border-[var(--line)] bg-white px-3.5 text-sm font-medium text-[var(--ink)] transition hover:bg-zinc-50">
          View history <ArrowUpRight size={16} aria-hidden="true" />
        </Link>
        {user.role === "EMPLOYEE" && hasPermission(user.role, "leave:submit") && (
          <Link href="/leave/new" className="inline-flex h-10 items-center rounded-md bg-[var(--action)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--action-hover)]">
            Apply for Leave
          </Link>
        )}
        {user.role === "EMPLOYEE" && hasPermission(user.role, "attendance:correction:submit") && (
          <Link href="/attendance/corrections" className="inline-flex h-10 items-center rounded-md border border-[var(--line)] bg-white px-4 text-sm font-semibold text-[var(--ink)] transition hover:bg-zinc-50">
            Request Attendance Correction
          </Link>
        )}
        {user.role === "EMPLOYEE" && hasPermission(user.role, "overtime:submit") && (
          <Link href="/overtime/new" className="inline-flex h-10 items-center rounded-md border border-[var(--line)] bg-white px-4 text-sm font-semibold text-[var(--ink)] transition hover:bg-zinc-50">
            Request Overtime
          </Link>
        )}
        {user.role === "EMPLOYEE" && hasPermission(user.role, "wfh:submit") && (
          <Link href="/wfh/new" className="inline-flex h-10 items-center rounded-md border border-[var(--line)] bg-white px-4 text-sm font-semibold text-[var(--ink)] transition hover:bg-zinc-50">
            Request WFH
          </Link>
        )}
      </div>

      <AttendanceToday activeSession={activeSession} previousDayActiveSession={previousDayActiveSession} activeSessionTiming={activeSessionTiming} previousDayActiveSessionTiming={previousDayActiveSessionTiming} day={day} attendanceDate={date} timeZone={user.timeZone} invalidSessions={invalidSessions} completedSessionToday={completedSessionToday} />

      <section aria-labelledby="summary-title">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div><h2 id="summary-title" className="text-base font-semibold">This month</h2><p className="mt-1 text-xs text-[var(--muted)]">{currentMonth} · saved attendance calculations</p></div>
            <div><h2 id="summary-title" className="text-base font-semibold">This month</h2><p className="mt-1 text-xs text-[var(--muted)]">{currentMonth} · correction-aware attendance engine</p></div>
          <Link href="/reports" className="text-sm font-medium text-[var(--blue)] hover:underline">Monthly details</Link>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {thisMonthMetrics.map(({ label, value }) => (
            <div key={label} className="min-h-[104px] rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold text-[var(--ink)]">{label}</p>
              <p className="mt-3 text-xl font-semibold tabular-nums">{value}</p>
            </div>
          ))}
        </div>
        {monthlyReport.summary.absentDays === null && <p role="note" className="mt-2 text-xs text-[var(--muted)]">Absence is shown only when an ABSENT status has been explicitly saved.</p>}
      </section>
    </div>
  );
}