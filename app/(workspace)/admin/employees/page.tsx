import Link from "next/link";
import { Plus, Search, Users } from "lucide-react";
import { requirePagePermission } from "@/lib/auth/session";
import { listEmployees } from "@/lib/employees/service";
import { measureServerOperation } from "@/lib/diagnostics/server-timing";

type SearchParams = { q?: string | string[]; page?: string | string[] };

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

function profileState(completedAt: Date | null, required: boolean) {
  if (completedAt) return "Complete";
  if (required) return "Required";
  return "Not requested";
}

export default async function AdminEmployeesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const admin = await requirePagePermission("employee:manage", "admin.employees");
  const params = await searchParams;
  const query = single(params.q).slice(0, 100);
  const page = Number(single(params.page)) || 1;
  const result = await measureServerOperation("admin.employees", "employees.directory_load", () => (
    listEmployees(admin, { query, page })
  ));
  const pageHref = (pageNumber: number) => `/admin/employees?${new URLSearchParams({ ...(query ? { q: query } : {}), page: String(pageNumber) })}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[var(--blue)]">Administration</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Employees</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">{result.total} employee{result.total === 1 ? "" : "s"}</p>
        </div>
        <Link href="/admin/employees/new" className="inline-flex h-11 items-center gap-2 rounded-lg bg-[var(--action)] px-4 text-sm font-semibold text-white hover:bg-[var(--action-hover)]"><Plus size={17} aria-hidden="true" /> Add employee</Link>
      </div>

      <form method="get" className="flex max-w-xl items-end gap-2">
        <label htmlFor="employee-search" className="min-w-0 flex-1 text-sm font-semibold">
          Search employees
          <input id="employee-search" name="q" type="search" maxLength={100} defaultValue={query} placeholder="Name, Employee ID, or NIC" className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm font-normal" />
        </label>
        <button type="submit" aria-label="Search employees" className="grid size-10 shrink-0 place-items-center rounded-md bg-[var(--action)] text-white hover:bg-[var(--action-hover)]"><Search size={17} aria-hidden="true" /></button>
      </form>

      {result.employees.length === 0 ? (
        <section className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-[var(--line)] bg-white px-6 text-center">
          <span className="grid size-12 place-items-center rounded-full bg-slate-100 text-[var(--blue)]"><Users size={21} aria-hidden="true" /></span>
          <h2 className="mt-4 text-base font-semibold">{query ? "No matching employees" : "No employees yet"}</h2>
          <p className="mt-2 max-w-sm text-sm leading-6 text-[var(--muted)]">{query ? "Try a different name, Employee ID, or NIC." : "Add an employee account to get started."}</p>
        </section>
      ) : (
        <section className="overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-sm" aria-label="Employee directory">
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--line)] bg-zinc-50 text-xs text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Employee</th>
                  <th className="px-4 py-3 font-semibold">Employee ID</th>
                  <th className="px-4 py-3 font-semibold">NIC</th>
                  <th className="px-4 py-3 font-semibold">EPF</th>
                  <th className="px-4 py-3 font-semibold">ETF</th>
                  <th className="px-4 py-3 font-semibold">Department</th>
                  <th className="px-4 py-3 font-semibold">Designation</th>
                  <th className="px-4 py-3 font-semibold">Shift</th>
                  <th className="px-4 py-3 font-semibold">Contact email</th>
                  <th className="px-4 py-3 font-semibold">Profile</th>
                  <th className="px-4 py-3 font-semibold">Account</th>
                  <th className="px-4 py-3 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)]">
                {result.employees.map((employee) => {
                  const href = `/admin/employees/${employee.userId ?? employee.id}`;
                  return (
                    <tr key={employee.id} className="hover:bg-zinc-50/70">
                      <td className="px-4 py-3"><Link href={href} className="font-semibold text-[var(--ink)] hover:text-[var(--blue)]">{employee.name}</Link></td>
                      <td className="px-4 py-3 text-[var(--muted)]">{employee.employeeId ?? "—"}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{employee.nic ?? "—"}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{employee.epfId ?? "—"}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{employee.etfId ?? "—"}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{employee.department?.name ?? "—"}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{employee.designation?.name ?? "—"}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{employee.shift?.name ?? "—"}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{employee.profile?.email ?? "—"}</td>
                      <td className="px-4 py-3">{profileState(employee.profileCompletedAt, employee.profileOnboardingRequired)}</td>
                      <td className="px-4 py-3">{employee.user ? employee.user.isActive ? "Active" : "Inactive" : "No account"}</td>
                      <td className="px-4 py-3"><Link href={href} className="font-medium text-[var(--blue)] hover:underline">View</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-[var(--line)] lg:hidden">
            {result.employees.map((employee) => {
              const href = `/admin/employees/${employee.userId ?? employee.id}`;
              return (
                <li key={employee.id}>
                  <Link href={href} className="block space-y-3 px-4 py-4 hover:bg-zinc-50/70">
                    <div className="flex items-start justify-between gap-3"><span className="min-w-0"><span className="block truncate text-sm font-semibold">{employee.name}</span><span className="mt-1 block truncate text-xs text-[var(--muted)]">{employee.profile?.email ?? "No contact email"}</span></span><span className="shrink-0 text-xs text-[var(--muted)]">{employee.user ? employee.user.isActive ? "Active" : "Inactive" : "No account"}</span></div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-[var(--muted)]"><span>ID: {employee.employeeId ?? "—"}</span><span>NIC: {employee.nic ?? "—"}</span><span>EPF: {employee.epfId ?? "—"}</span><span>ETF: {employee.etfId ?? "—"}</span><span>Department: {employee.department?.name ?? "—"}</span><span>Designation: {employee.designation?.name ?? "—"}</span><span>Shift: {employee.shift?.name ?? "—"}</span><span className="col-span-2">Profile: {profileState(employee.profileCompletedAt, employee.profileOnboardingRequired)}</span></div>
                  </Link>
                </li>
              );
            })}
          </ul>
          {result.pageCount > 1 && (
            <nav aria-label="Employee pages" className="flex items-center justify-between border-t border-[var(--line)] px-4 py-3 text-sm">
              <span className="text-[var(--muted)]">Page {result.page} of {result.pageCount}</span>
              <div className="flex gap-2">
                {result.page > 1 && <Link href={pageHref(result.page - 1)} className="rounded-md border border-[var(--line)] px-3 py-1.5 hover:bg-zinc-50">Previous</Link>}
                {result.page < result.pageCount && <Link href={pageHref(result.page + 1)} className="rounded-md border border-[var(--line)] px-3 py-1.5 hover:bg-zinc-50">Next</Link>}
              </div>
            </nav>
          )}
        </section>
      )}
    </div>
  );
}