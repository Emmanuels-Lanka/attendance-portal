import Image from "next/image";
import { LogOut } from "lucide-react";
import { AppNav, MobileNav } from "@/components/app-nav";
import { logoutAction } from "@/app/(auth)/logout/action";
import type { Role } from "@prisma/client";
import { hasPermission } from "@/lib/auth/permissions";

type AppUser = { name: string; email: string; role: Role };

export function AppShell({ user, children }: { user: AppUser; children: React.ReactNode }) {
  const initials = user.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const canReviewCorrections = user.role === "SUPERVISOR" || user.role === "HR_ADMINISTRATOR";
  const canReviewLeave = user.role === "SUPERVISOR";
  const canReadLeaveBalance = user.role === "EMPLOYEE" && hasPermission(user.role, "leave:balance:self:read");
  const canManageEmployees = hasPermission(user.role, "employee:manage");
  const canManageAttendance = hasPermission(user.role, "attendance:manage");
  const canManageShifts = hasPermission(user.role, "shift:manage");
  const canManageLeave = hasPermission(user.role, "leave:manage");
  const canReadReports = hasPermission(user.role, "reports:read");
  const canReadDepartmentReports = hasPermission(user.role, "reports:department:read");
  const canSubmitOvertime = user.role === "EMPLOYEE" && hasPermission(user.role, "overtime:submit");
  const canReviewOvertime = (user.role === "SUPERVISOR" || user.role === "DEPARTMENT_MANAGER")
    && hasPermission(user.role, "overtime:approve");
  const canSubmitWorkFromHome = user.role === "EMPLOYEE" && hasPermission(user.role, "wfh:submit");
  const canReviewWorkFromHome = (user.role === "SUPERVISOR" || user.role === "DEPARTMENT_MANAGER")
    && hasPermission(user.role, "wfh:approve");

  return (
    <div className="min-h-screen md:flex">
      <aside className="fixed inset-y-0 z-40 hidden w-64 shrink-0 flex-col bg-[var(--sidebar)] text-white md:flex">
        <div className="flex h-[70px] items-center border-b border-white/15 px-6">
          <Image src="/eliot-logo.png" alt="ELIoT" width={1200} height={600} priority className="h-10 w-[92px] object-contain object-left" />
        </div>
        <AppNav isAdmin={user.role === "ADMIN"} canManageEmployees={canManageEmployees} canManageAttendance={canManageAttendance} canManageShifts={canManageShifts} canManageLeave={canManageLeave} canReadLeaveBalance={canReadLeaveBalance} canReviewCorrections={canReviewCorrections} canReviewLeave={canReviewLeave} canReadReports={canReadReports} canReadDepartmentReports={canReadDepartmentReports} canSubmitOvertime={canSubmitOvertime} canReviewOvertime={canReviewOvertime} canSubmitWorkFromHome={canSubmitWorkFromHome} canReviewWorkFromHome={canReviewWorkFromHome} />
        <div className="mt-auto border-t border-white/15 p-4">
          <p className="truncate text-xs font-semibold text-white">{user.name}</p>
          <p className="mt-1 truncate text-[11px] text-white/60">{user.email}</p>
        </div>
      </aside>
      <div className="min-h-screen min-w-0 flex-1 md:ml-64">
        <header className="sticky top-0 z-30 flex h-[70px] items-center justify-between border-b border-[var(--line)] bg-white px-4 shadow-sm sm:px-7">
          <div className="flex items-center gap-3 md:hidden">
            <MobileNav isAdmin={user.role === "ADMIN"} canManageEmployees={canManageEmployees} canManageAttendance={canManageAttendance} canManageShifts={canManageShifts} canManageLeave={canManageLeave} canReadLeaveBalance={canReadLeaveBalance} canReviewCorrections={canReviewCorrections} canReviewLeave={canReviewLeave} canReadReports={canReadReports} canReadDepartmentReports={canReadDepartmentReports} canSubmitOvertime={canSubmitOvertime} canReviewOvertime={canReviewOvertime} canSubmitWorkFromHome={canSubmitWorkFromHome} canReviewWorkFromHome={canReviewWorkFromHome} user={user} />
            <Image src="/eliot-logo.png" alt="ELIoT Attendance" width={1200} height={600} priority className="h-9 w-[82px] object-contain object-left" />
          </div>
          <div className="hidden min-w-0 items-center gap-3 md:flex">
            <span className="grid size-9 place-items-center rounded-full bg-slate-100 text-xs font-bold text-[var(--blue)]">{initials || "U"}</span>
            <div className="min-w-0"><p className="truncate text-sm font-semibold">{user.name}</p><p className="text-xs text-[var(--muted)]">{user.role === "ADMIN" ? "Super Administrator" : user.role === "HR_ADMINISTRATOR" ? "HR Administrator" : user.role === "EMPLOYEE" ? "Employee" : user.role === "DEPARTMENT_MANAGER" ? "Department Manager" : "Supervisor"}</p></div>
          </div>
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-full bg-slate-100 text-xs font-bold text-[var(--blue)] md:hidden">{initials || "U"}</span>
            <form action={logoutAction}>
              <button type="submit" title="Sign out" aria-label="Sign out" className="grid size-10 place-items-center rounded-sm text-[var(--muted)] transition hover:bg-zinc-100 hover:text-[var(--ink)]"><LogOut size={18} aria-hidden="true" /></button>
            </form>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-7 sm:py-8">{children}</main>
      </div>
    </div>
  );
}