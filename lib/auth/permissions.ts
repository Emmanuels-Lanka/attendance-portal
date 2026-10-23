import type { Role } from "@prisma/client";

export type Permission =
  | "employee:manage"
  | "employee:records:read"
  | "attendance:manage"
  | "attendance:locations:read"
  | "audit:read"
  | "attendance:department:read"
  | "attendance:assigned:read"
  | "attendance:monitor"
  | "attendance:missing-punch:review"
  | "attendance:correction:manage"
  | "attendance:correction:approve"
  | "attendance:correction:submit"
  | "leave:manage"
  | "leave:approve"
  | "leave:submit"
  | "leave:request:self:read"
  | "leave:balance:self:read"
  | "overtime:submit"
  | "overtime:approve"
  | "wfh:submit"
  | "wfh:approve"
  | "shift:manage"
  | "holiday:manage"
  | "reports:read"
  | "reports:department:read"
  | "payroll:export"
  | "roster:self:read"
  | "notifications:self:read";

const rolePermissions: Record<Exclude<Role, "ADMIN">, readonly Permission[]> = {
  EMPLOYEE: [
    "attendance:correction:submit",
    "leave:submit",
    "leave:request:self:read",
    "leave:balance:self:read",
    "overtime:submit",
    "wfh:submit",
    "roster:self:read",
    "notifications:self:read",
  ],
  HR_ADMINISTRATOR: [
    "employee:manage",
    "employee:records:read",
    "attendance:manage",
    "attendance:locations:read",
    "audit:read",
    "attendance:correction:manage",
    "attendance:correction:approve",
    "attendance:correction:submit",
    "leave:manage",
    "leave:approve",
    "shift:manage",
    "holiday:manage",
    "reports:read",
    "payroll:export",
  ],
  DEPARTMENT_MANAGER: [
    "attendance:department:read",
    "attendance:correction:approve",
    "leave:approve",
    "overtime:approve",
    "wfh:approve",
    "reports:department:read",
  ],
  SUPERVISOR: [
    "attendance:assigned:read",
    "attendance:monitor",
    "attendance:missing-punch:review",
    "attendance:correction:submit",
    "attendance:correction:approve",
    "leave:approve",
    "overtime:approve",
    "wfh:approve",
  ],
};

// ADMIN remains the existing full-access Super Administrator role.
export function hasPermission(role: Role, permission: Permission) {
  if (role === "ADMIN") return true;
  return rolePermissions[role].includes(permission);
}

export function canSubmitOwnAttendanceCorrection(role: Role) {
  return (role === "EMPLOYEE" || role === "HR_ADMINISTRATOR")
    && hasPermission(role, "attendance:correction:submit");
}

export function canReadScopedAttendance(role: Role) {
  return role !== "ADMIN" && (hasPermission(role, "attendance:department:read")
    || (hasPermission(role, "attendance:assigned:read") && hasPermission(role, "attendance:monitor")));
}
