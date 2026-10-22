"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import {
  adminEmployeeSelect,
  changedEmployeeFieldNames,
  createEmployee,
  EmployeeAdministratorAccountError,
  EmployeeDuplicateError,
  setEmployeeActive,
  EmployeeReportingAssignmentError,
  updateEmployee,
  writeEmployeeAuditEvent,
} from "@/lib/employees/service";
import { OrganizationNotFoundError } from "@/lib/organization/service";
import {
  ShiftAssignmentConflictError,
  ShiftNotFoundError,
  ShiftWorkingDaysConfigurationError,
} from "@/lib/shifts/service";

export type EmployeeActionState = { error: string } | null;

function employeeFormData(formData: FormData) {
  const profileFields = [
    ["permanentAddress", "permanentAddress"],
    ["currentAddress", "currentAddress"],
    ["emergencyContactName", "emergencyContactName"],
    ["emergencyContactId", "emergencyContactId"],
    ["emergencyContactAddress", "emergencyContactAddress"],
    ["emergencyContactPhone", "emergencyContactPhone"],
    ["emergencyContactRelationship", "emergencyContactRelationship"],
    ["contactNumber", "contactNumber"],
    ["profileEmail", "email"],
    ["linkedInId", "linkedInId"],
    ["dateOfBirth", "dateOfBirth"],
    ["maritalStatus", "maritalStatus"],
    ["spouseName", "spouseName"],
    ["spouseId", "spouseId"],
    ["motherName", "motherName"],
    ["motherId", "motherId"],
    ["motherContactNumber", "motherContactNumber"],
    ["fatherName", "fatherName"],
    ["fatherId", "fatherId"],
    ["fatherContactNumber", "fatherContactNumber"],
  ] as const;

  const profile = Object.fromEntries(profileFields
    .filter(([formField]) => formData.has(formField))
    .map(([formField, profileField]) => [profileField, formData.get(formField)]));

  return {
    name: formData.get("name"),
    employeeCode: formData.get("employeeCode"),
    nic: formData.get("nic"),
    epfId: formData.get("epfId"),
    etfId: formData.get("etfId"),
    departmentId: formData.get("departmentId"),
    designationId: formData.get("designationId"),
    shiftId: formData.get("shiftId"),
    shiftIds: formData.has("shiftAssignmentsSubmitted")
      ? formData.getAll("shiftIds").filter((shiftId): shiftId is string => typeof shiftId === "string" && shiftId.length > 0)
      : undefined,
    shiftEffectiveFrom: formData.get("shiftEffectiveFrom"),
    supervisorId: formData.get("supervisorId"),
    managerId: formData.get("managerId"),
    email: formData.get("email"),
    username: formData.get("username"),
    password: formData.get("password"),
    role: formData.get("role"),
    countryCode: formData.get("countryCode"),
    timeZone: formData.get("timeZone"),
    profile,
  };
}

function employeeAuditSnapshot(employee: NonNullable<Awaited<ReturnType<typeof loadAuditEmployee>>>) {
  return {
    name: employee.name,
    employeeId: employee.employeeId,
    nic: employee.nic,
    epfId: employee.epfId,
    etfId: employee.etfId,
    departmentId: employee.departmentId,
    designationId: employee.designationId,
    shiftId: employee.shiftId,
    shiftAssignments: employee.shiftAssignments
      .map(({ shiftId, effectiveFrom, effectiveTo }) => ({
        shiftId,
        effectiveFrom: effectiveFrom.toISOString().slice(0, 10),
        effectiveTo: effectiveTo?.toISOString().slice(0, 10) ?? null,
      }))
      .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom) || left.shiftId.localeCompare(right.shiftId)),
    supervisorId: employee.supervisorId,
    managerId: employee.managerId,
    loginEmail: employee.user?.email,
    loginUsername: employee.user?.username,
    role: employee.user?.role,
    isActive: employee.user?.isActive,
    countryCode: employee.user?.countryCode,
    timeZone: employee.user?.timeZone,
    ...Object.fromEntries(Object.entries(employee.profile ?? {}).map(([field, value]) => [`profile.${field}`, value])),
  };
}

function loadAuditEmployee(database: typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0], userId: string) {
  return database.employee.findUnique({ where: { userId }, select: adminEmployeeSelect });
}

function actionError(error: unknown) {
  if (error instanceof EmployeeAdministratorAccountError) return error.message;
  if (error instanceof EmployeeDuplicateError) return error.message;
  if (error instanceof OrganizationNotFoundError) return error.message;
  if (error instanceof ShiftNotFoundError) return error.message;
  if (error instanceof ShiftAssignmentConflictError) return error.message;
  if (error instanceof ShiftWorkingDaysConfigurationError) return error.message;
  if (error instanceof EmployeeReportingAssignmentError) return error.message;
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Check the employee details and try again.";
  console.error("Employee management action failed", error instanceof Error ? error.name : "Unknown error");
  return "The employee could not be saved. Try again shortly.";
}

export async function createEmployeeAction(_state: EmployeeActionState, formData: FormData): Promise<EmployeeActionState> {
  let employee;
  try {
    const admin = await requirePermission("employee:manage");
    employee = await prisma.$transaction(async (tx) => {
      const created = await createEmployee(admin, employeeFormData(formData), tx);
      await writeEmployeeAuditEvent(tx, {
        employeeId: created.id,
        actorId: admin.id,
        actionType: "EMPLOYEE_CREATED",
        changedFields: ["name", "employeeId", "nic", "epfId", "etfId", "departmentId", "designationId", "shiftId", "shiftAssignments", "supervisorId", "managerId", "loginEmail", "loginUsername", "role", "countryCode", "timeZone"],
      });
      return created;
    });
  } catch (error) {
    return { error: actionError(error) };
  }

  revalidatePath("/admin/employees");
  redirect(`/admin/employees/${employee.id}`);
}

export async function updateEmployeeAction(employeeId: string, _state: EmployeeActionState, formData: FormData): Promise<EmployeeActionState> {
  try {
    const admin = await requirePermission("employee:manage");
    await prisma.$transaction(async (tx) => {
      const previous = await loadAuditEmployee(tx, employeeId);
      if (!previous) throw new Error("Employee not found.");
      await updateEmployee(admin, employeeId, employeeFormData(formData), tx);
      const updated = await loadAuditEmployee(tx, employeeId);
      if (!updated) throw new Error("Employee not found.");
      const changedFields = changedEmployeeFieldNames(employeeAuditSnapshot(previous), employeeAuditSnapshot(updated));
      if (changedFields.length === 0) return;
      await writeEmployeeAuditEvent(tx, {
        employeeId,
        actorId: admin.id,
        actionType: "EMPLOYEE_UPDATED",
        changedFields,
      });
    });
  } catch (error) {
    return { error: actionError(error) };
  }

  revalidatePath("/admin/employees");
  revalidatePath(`/admin/employees/${employeeId}`);
  redirect(`/admin/employees/${employeeId}`);
}

export async function setEmployeeActiveAction(employeeId: string, isActive: boolean) {
  const admin = await requirePermission("employee:manage");
  await prisma.$transaction(async (tx) => {
    const previous = await tx.user.findUnique({ where: { id: employeeId }, select: { isActive: true } });
    if (!previous) throw new Error("Employee not found.");
    if (previous.isActive === isActive) return;
    await setEmployeeActive(admin, employeeId, isActive, tx);
    await tx.attendanceAuditLog.create({
      data: {
        employeeId,
        actorId: admin.id,
        actionType: isActive ? "EMPLOYEE_ACTIVATED" : "EMPLOYEE_DEACTIVATED",
        previousValues: { isActive: previous.isActive },
        newValues: { isActive },
        reason: isActive ? "Administrator reactivated the employee account." : "Administrator deactivated the account; attendance history is retained.",
      },
      select: { id: true, employeeId: true, actorId: true, actionType: true, previousValues: true, newValues: true, reason: true, createdAt: true },
    });
  });
  revalidatePath("/admin/employees");
  revalidatePath(`/admin/employees/${employeeId}`);
  redirect(`/admin/employees/${employeeId}`);
}