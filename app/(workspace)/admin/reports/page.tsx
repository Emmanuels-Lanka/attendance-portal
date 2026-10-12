import Link from "next/link";

import { formatWorkedDuration } from "@/lib/attendance/history";
import { getAdminMonthlyReport } from "@/lib/attendance/reports";
import { requirePageAdmin } from "@/lib/auth/session";

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams?: Promise<{ month?: string | string[]; [key: string]: string | string[] | undefined }>;
}) {
  await requirePageAdmin();
  const params = (await searchParams) ?? {};
  const month = typeof params.month === "string" ? params.month : new Date().toISOString().slice(0, 7);
  const { employees, summary } = await getAdminMonthlyReport(month);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium text-[var(--blue)]">Administration</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Attendance reports</h1>
        </div>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-3">
          <form method="GET" className="flex w-full items-center gap-2 lg:w-auto">
            <input type="month" name="month" defaultValue={month} className="min-w-0 flex-1 rounded-md border border-[var(--line)] px-3 py-2 text-sm lg:flex-none" />
            <button type="submit" className="rounded-md bg-[var(--action)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--action-hover)]">Apply</button>
          </form>
          <div className="flex flex-wrap gap-2">
            <Link href={`/admin/reports/export?month=${month}`} className="inline-flex justify-center rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium text-[var(--ink)]">Download PDF</Link>
            <Link href={`/reports/monthly/export?month=${month}&format=xlsx`} className="inline-flex justify-center rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium text-[var(--ink)]">Download Excel</Link>
            <Link href={`/reports/monthly/export?month=${month}&format=csv`} className="inline-flex justify-center rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium text-[var(--ink)]">Download CSV</Link>
          </div>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm"><p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Employees</p><p className="mt-2 text-2xl font-semibold">{employees.length}</p></div>
        <div className="rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm"><p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Sessions</p><p className="mt-2 text-2xl font-semibold">{summary.totalSessions}</p></div>
        <div className="rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm"><p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Worked time</p><p className="mt-2 text-2xl font-semibold">{formatWorkedDuration(summary.totalWorkedMs)}</p></div>
      </div>

      <section className="rounded-lg border border-[var(--line)] bg-white shadow-sm">
        <header className="border-b border-[var(--line)] px-5 py-4"><h2 className="text-base font-semibold">Employee totals</h2></header>
        <div className="divide-y divide-[var(--line)]">
          {employees.map(({ employee, report }) => (
            <div key={employee.id} className="px-5 py-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold">{employee.name}</p>
                  <p className="text-xs text-[var(--muted)]">{employee.email}</p>
                </div>
                <div className="text-sm text-[var(--muted)]">{report.summary.totalSessions} sessions · {formatWorkedDuration(report.summary.totalWorkedMs)}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

    </div>
  );
}
