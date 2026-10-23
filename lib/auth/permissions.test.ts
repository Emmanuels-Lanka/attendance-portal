import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role } from "@prisma/client";
import { canAccessPersonalAttendance, canReadScopedAttendance, canSubmitOwnAttendanceCorrection, hasPermission } from "./permissions";

describe("role permissions", () => {
  it("preserves ADMIN as the full-access compatibility role", () => {
    assert.equal(hasPermission(Role.ADMIN, "employee:manage"), true);
    assert.equal(hasPermission(Role.ADMIN, "leave:approve"), true);
    assert.equal(hasPermission(Role.ADMIN, "payroll:export"), true);
    assert.equal(hasPermission(Role.ADMIN, "audit:read"), true);
    assert.equal(hasPermission(Role.ADMIN, "attendance:correction:manage"), true);
    assert.equal(hasPermission(Role.ADMIN, "attendance:correction:approve"), true);
  });

  it("grants HR Administrator the SRS HR management capabilities", () => {
    assert.equal(hasPermission(Role.HR_ADMINISTRATOR, "employee:manage"), true);
    assert.equal(hasPermission(Role.HR_ADMINISTRATOR, "attendance:manage"), true);
    assert.equal(hasPermission(Role.HR_ADMINISTRATOR, "attendance:locations:read"), true);
    assert.equal(hasPermission(Role.HR_ADMINISTRATOR, "audit:read"), true);
    assert.equal(hasPermission(Role.HR_ADMINISTRATOR, "leave:manage"), true);
    assert.equal(hasPermission(Role.HR_ADMINISTRATOR, "shift:manage"), true);
    assert.equal(hasPermission(Role.HR_ADMINISTRATOR, "holiday:manage"), true);
    assert.equal(hasPermission(Role.HR_ADMINISTRATOR, "reports:read"), true);
    assert.equal(hasPermission(Role.HR_ADMINISTRATOR, "leave:approve"), true);
    assert.equal(hasPermission(Role.HR_ADMINISTRATOR, "leave:request:self:read"), true);
    assert.equal(hasPermission(Role.HR_ADMINISTRATOR, "attendance:correction:approve"), true);
    assert.equal(hasPermission(Role.HR_ADMINISTRATOR, "attendance:correction:manage"), true);
    assert.equal(hasPermission(Role.HR_ADMINISTRATOR, "attendance:correction:submit"), true);
    assert.equal(canSubmitOwnAttendanceCorrection(Role.HR_ADMINISTRATOR), true);
  });

  it("limits Department Manager permissions to the SRS department duties", () => {
    assert.equal(hasPermission(Role.DEPARTMENT_MANAGER, "attendance:department:read"), true);
    assert.equal(hasPermission(Role.DEPARTMENT_MANAGER, "attendance:correction:manage"), true);
    assert.equal(hasPermission(Role.DEPARTMENT_MANAGER, "attendance:correction:approve"), true);
    assert.equal(hasPermission(Role.DEPARTMENT_MANAGER, "leave:approve"), true);
    assert.equal(hasPermission(Role.DEPARTMENT_MANAGER, "attendance:manage"), false);
    assert.equal(hasPermission(Role.DEPARTMENT_MANAGER, "attendance:locations:read"), false);
    assert.equal(hasPermission(Role.DEPARTMENT_MANAGER, "employee:manage"), false);
    assert.equal(hasPermission(Role.DEPARTMENT_MANAGER, "holiday:manage"), false);
    assert.equal(hasPermission(Role.DEPARTMENT_MANAGER, "audit:read"), false);
  });

  it("limits Supervisor permissions to assigned employee work and request review", () => {
    assert.equal(hasPermission(Role.SUPERVISOR, "attendance:assigned:read"), true);
    assert.equal(hasPermission(Role.SUPERVISOR, "attendance:correction:approve"), true);
    assert.equal(hasPermission(Role.SUPERVISOR, "attendance:correction:manage"), false);
    assert.equal(hasPermission(Role.SUPERVISOR, "leave:approve"), true);
    assert.equal(hasPermission(Role.SUPERVISOR, "attendance:department:read"), false);
    assert.equal(hasPermission(Role.SUPERVISOR, "attendance:locations:read"), false);
    assert.equal(hasPermission(Role.SUPERVISOR, "leave:manage"), false);
    assert.equal(hasPermission(Role.SUPERVISOR, "audit:read"), false);
    assert.equal(canReadScopedAttendance(Role.SUPERVISOR), true);
  });

  it("grants scoped attendance reads only to Department Managers and monitored Supervisors", () => {
    assert.equal(canReadScopedAttendance(Role.DEPARTMENT_MANAGER), true);
    assert.equal(canReadScopedAttendance(Role.HR_ADMINISTRATOR), false);
    assert.equal(canReadScopedAttendance(Role.EMPLOYEE), false);
    assert.equal(canReadScopedAttendance(Role.ADMIN), false);
  });

  it("keeps Employee permissions self-service only", () => {
    assert.equal(hasPermission(Role.EMPLOYEE, "leave:submit"), true);
    assert.equal(hasPermission(Role.EMPLOYEE, "leave:request:self:read"), true);
    assert.equal(hasPermission(Role.EMPLOYEE, "leave:balance:self:read"), true);
    assert.equal(hasPermission(Role.EMPLOYEE, "leave:approve"), false);
    assert.equal(hasPermission(Role.EMPLOYEE, "attendance:department:read"), false);
    assert.equal(hasPermission(Role.EMPLOYEE, "attendance:locations:read"), false);
    assert.equal(hasPermission(Role.EMPLOYEE, "audit:read"), false);
    assert.equal(canSubmitOwnAttendanceCorrection(Role.EMPLOYEE), true);
    assert.equal(canSubmitOwnAttendanceCorrection(Role.SUPERVISOR), false);
    assert.equal(canSubmitOwnAttendanceCorrection(Role.ADMIN), false);
  });

  it("keeps personal attendance available to non-admin roles only", () => {
    assert.equal(canAccessPersonalAttendance(Role.ADMIN), false);
    assert.equal(canAccessPersonalAttendance(Role.EMPLOYEE), true);
    assert.equal(canAccessPersonalAttendance(Role.HR_ADMINISTRATOR), true);
    assert.equal(canAccessPersonalAttendance(Role.DEPARTMENT_MANAGER), true);
    assert.equal(canAccessPersonalAttendance(Role.SUPERVISOR), true);
  });
});
