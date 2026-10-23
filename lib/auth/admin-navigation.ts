import type { Role } from "@prisma/client";

export function getDashboardHomePath(role: Role) {
  return role === "ADMIN" ? "/admin" : "/dashboard";
}

export const adminNavigationItems = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/employees", label: "Employees" },
  { href: "/admin/departments", label: "Departments" },
  { href: "/admin/designations", label: "Designations" },
  { href: "/admin/shifts", label: "Shifts" },
  { href: "/holidays", label: "Holiday calendar" },
  { href: "/admin/attendance", label: "Attendance management" },
  { href: "/admin/attendance/daily", label: "Daily attendance" },
  { href: "/approvals/attendance-corrections", label: "Correction approvals" },
  { href: "/admin/reports", label: "Attendance reports" },
  { href: "/admin/leave-types", label: "Leave Types" },
  { href: "/admin/leave-balances", label: "Leave balances" },
  { href: "/admin/audit", label: "Audit history" },
  { href: "/admin/settings", label: "Policy settings" },
  { href: "/notifications", label: "Notifications" },
  { href: "/settings", label: "Settings" },
] as const;
