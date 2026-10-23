import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, BriefcaseBusiness, CalendarDays, Clock3, SlidersHorizontal, Users, ChartNoAxesColumn, ClipboardList } from "lucide-react";
import { requirePageUser } from "@/lib/auth/session";

const sections = [
  { href: "/admin/employees", label: "Employees", description: "Employee directory foundation", icon: Users },
  { href: "/admin/departments", label: "Departments", description: "Manage employee departments", icon: BriefcaseBusiness },
  { href: "/admin/designations", label: "Designations", description: "Manage employee designations", icon: BriefcaseBusiness },
  { href: "/admin/shifts", label: "Shifts", description: "Manage employee shifts", icon: Clock3 },
  { href: "/admin/leave-types", label: "Leave Types", description: "Manage configurable Leave Types", icon: BriefcaseBusiness },
  { href: "/admin/leave-balances", label: "Leave balances", description: "Review employee leave credits and calculated balances", icon: BriefcaseBusiness },
  { href: "/admin/attendance", label: "Attendance", description: "Organization attendance records", icon: CalendarDays },
  { href: "/approvals/attendance-corrections", label: "Correction approvals", description: "Review organization-wide attendance correction requests", icon: ClipboardList },
  { href: "/admin/reports", label: "Reports", description: "Organization reporting foundation", icon: ChartNoAxesColumn },
  { href: "/admin/audit", label: "Audit history", description: "Review administrative and attendance changes", icon: ClipboardList },
  { href: "/admin/settings", label: "Settings", description: "Policy configuration foundation", icon: SlidersHorizontal },
];

export default async function AdminPage() {
  const actor = await requirePageUser();
  if (actor.role !== "ADMIN") redirect("/admin/employees");

  return (
    <div className="space-y-6">
      <div><p className="text-sm font-medium text-[var(--blue)]">Administration</p><h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Admin workspace</h1><p className="mt-2 text-sm text-[var(--muted)]">Protected administration routes for the attendance system.</p></div>
      <div className="grid gap-3 sm:grid-cols-2">
        {sections.map(({ href, label, description, icon: Icon }) => (
          <Link key={href} href={href} className="group flex min-h-28 items-center gap-4 rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm transition hover:border-slate-300 hover:bg-zinc-50">
            <span className="grid size-11 shrink-0 place-items-center rounded-md bg-slate-100 text-[var(--blue)]"><Icon size={20} aria-hidden="true" /></span>
            <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{label}</span><span className="mt-1 block text-xs leading-5 text-[var(--muted)]">{description}</span></span>
            <ArrowRight size={17} className="shrink-0 text-[var(--muted)] transition group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
        ))}
      </div>
    </div>
  );
}