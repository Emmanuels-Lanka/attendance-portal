import "server-only";

import type { Prisma, PrismaClient, Role } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import { hasPermission } from "@/lib/auth/permissions";
import { createEmployeeSchema, updateEmployeeSchema, type AdminEmployeeProfilePatch } from "@/lib/employees/validation";
import { employeeProfileRequiredFields } from "@/lib/employees/profile-requirements";
import { validateEmployeeOrganizationAssignments } from "@/lib/organization/service";
import {
  ShiftAssignmentConflictError,
  validateEmployeeShiftAssignments,
} from "@/lib/shifts/service";

export const publicEmployeeSelect = {
  id: true,
  name: true,
  employeeCode: true,
  email: true,
  role: true,
  countryCode: true,
  timeZone: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

type EmployeeDatabase = Pick<PrismaClient, "user" | "employee" | "department" | "designation" | "shift">;
type AdminEmployeeDatabase = Pick<PrismaClient, "employee">;
type EmployeeAdmin = { role: Role };

export const adminEmployeeSelect = {
  id: true,
  name: true,
  employeeId: true,
  nic: true,
  epfId: true,
  etfId: true,
  departmentId: true,
  designationId: true,
  shiftId: true,
  supervisorId: true,
  managerId: true,
  userId: true,
  profileCompletedAt: true,
  profileOnboardingRequired: true,
  department: { select: { id: true, name: true } },
  designation: { select: { id: true, name: true } },
  shift: { select: { id: true, name: true } },
  shiftAssignments: {
    select: {
      id: true,
      shiftId: true,
      effectiveFrom: true,
      effectiveTo: true,
      shift: { select: { id: true, name: true, workingDays: true } },
    },
  },
  supervisor: { select: { id: true, name: true, employeeId: true } },
  manager: { select: { id: true, name: true, employeeId: true } },
  user: { select: { id: true, email: true, username: true, role: true, isActive: true, countryCode: true, timeZone: true } },
  profile: {
    select: {
      permanentAddress: true,
      currentAddress: true,
      emergencyContactName: true,
      emergencyContactId: true,
      emergencyContactAddress: true,
      emergencyContactPhone: true,
      emergencyContactRelationship: true,
      contactNumber: true,
      email: true,
      linkedInId: true,
      dateOfBirth: true,
      maritalStatus: true,
      spouseName: true,
      spouseId: true,
      motherName: true,
      motherId: true,
      motherContactNumber: true,
      fatherName: true,
      fatherId: true,
      fatherContactNumber: true,
      gender: true,
      genderCustom: true,
    },
  },
} as const;

const adminEmployeeListSelect = {
  id: true,
  name: true,
  employeeId: true,
  nic: true,
  epfId: true,
  etfId: true,
  departmentId: true,
  designationId: true,
  shiftId: true,
  userId: true,
  profileCompletedAt: true,
  profileOnboardingRequired: true,
  department: { select: { id: true, name: true } },
  designation: { select: { id: true, name: true } },
  shift: { select: { id: true, name: true } },
  user: { select: { id: true, isActive: true } },
  profile: { select: { email: true } },
} as const;

const employeeListQuerySchema = z.object({
  query: z.string().trim().max(100).default(""),
  page: z.coerce.number().int().min(1).catch(1),
  pageSize: z.coerce.number().int().min(1).max(50).catch(20),
});

export class EmployeeAccessError extends Error {
  constructor() {
    super("Only HR Administrators and Super Administrators can manage employees.");
    this.name = "EmployeeAccessError";
  }
}

export class EmployeeAdministratorAccountError extends Error {
  constructor() {
    super("Only a Super Administrator can create or modify administrator accounts.");
    this.name = "EmployeeAdministratorAccountError";
  }
}

export class EmployeeDuplicateError extends Error {
  constructor(readonly field: "email" | "username" | "employeeCode" | "employeeId" | "nic" | "unknown") {
    const label = field === "email" ? "login email" : field === "username" ? "username" : field === "employeeCode" || field === "employeeId" ? "Employee ID" : "NIC";
    super(field === "unknown" ? "An employee with these details already exists." : `That ${label} is already in use.`);
    this.name = "EmployeeDuplicateError";
  }
}

export class EmployeeNotFoundError extends Error {
  constructor() {
    super("Employee not found.");
    this.name = "EmployeeNotFoundError";
  }
}

export class EmployeeReportingAssignmentError extends Error {
  constructor(kind: "supervisor" | "manager") {
    super(`Choose a valid ${kind === "supervisor" ? "Supervisor" : "Department Manager"} for this employee.`);
    this.name = "EmployeeReportingAssignmentError";
  }
}

export function changedEmployeeFieldNames(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
) {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...keys].filter((key) => JSON.stringify(previous[key] ?? null) !== JSON.stringify(current[key] ?? null)).sort();
}

export function employeeAuditMetadata(changedFields: string[]) {
  return { changedFields };
}

export async function writeEmployeeAuditEvent(
  database: Pick<PrismaClient, "attendanceAuditLog">,
  input: {
    employeeId: string | null;
    actorId: string;
    actionType: "EMPLOYEE_CREATED" | "EMPLOYEE_UPDATED" | "EMPLOYEE_DOCUMENT_UPLOADED";
    changedFields: string[];
  },
) {
  await database.attendanceAuditLog.create({
    data: {
      employeeId: input.employeeId,
      actorId: input.actorId,
      actionType: input.actionType,
      ...(input.actionType === "EMPLOYEE_UPDATED" ? { previousValues: employeeAuditMetadata(input.changedFields) } : {}),
      newValues: employeeAuditMetadata(input.changedFields),
      reason: input.actionType === "EMPLOYEE_CREATED"
        ? "An authorized administrator created an employee account; field values are omitted for privacy."
        : input.actionType === "EMPLOYEE_DOCUMENT_UPLOADED"
          ? "An authorized user uploaded an employee document; filenames and contents are omitted for privacy."
          : "An authorized administrator updated employee identity or profile fields; values are omitted for privacy.",
    },
    select: { id: true },
  });
}

function assertEmployeeManager(actor: EmployeeAdmin) {
  if (!hasPermission(actor.role, "employee:manage")) throw new EmployeeAccessError();
}

function assertCanAssignRole(actor: EmployeeAdmin, role: Role) {
  if (actor.role !== "ADMIN" && (role === "ADMIN" || role === "HR_ADMINISTRATOR")) {
    throw new EmployeeAdministratorAccountError();
  }
}

async function assertCanManageExistingAccount(actor: EmployeeAdmin, employeeId: string, database: EmployeeDatabase) {
  if (actor.role === "ADMIN") return;
  const target = await database.user.findUnique({ where: { id: employeeId }, select: { role: true } });
  if (!target) throw new EmployeeNotFoundError();
  if (target.role === "ADMIN" || target.role === "HR_ADMINISTRATOR") {
    throw new EmployeeAdministratorAccountError();
  }
}

function duplicateField(error: unknown): "email" | "username" | "employeeCode" | "employeeId" | "nic" | "unknown" | null {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "P2002") return null;
  const target = "meta" in error && error.meta && typeof error.meta === "object" && "target" in error.meta
    ? error.meta.target
    : undefined;
  const targetText = Array.isArray(target) ? target.join(",") : String(target ?? "");
  if (targetText.includes("email")) return "email";
  if (targetText.toLowerCase().includes("username")) return "username";
  if (targetText.includes("employeeCode")) return "employeeCode";
  if (targetText.includes("employeeId")) return "employeeId";
  if (targetText.includes("nic")) return "nic";
  return "unknown";
}

async function withDuplicateTranslation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const field = duplicateField(error);
    if (field) throw new EmployeeDuplicateError(field);
    throw error;
  }
}

export async function listEmployees(
  admin: EmployeeAdmin,
  input: unknown = {},
  database: AdminEmployeeDatabase = prisma,
) {
  assertEmployeeManager(admin);
  const { query, page, pageSize } = employeeListQuerySchema.parse(input);
  const where: Prisma.EmployeeWhereInput = {
    ...(query ? {
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { employeeId: { contains: query, mode: "insensitive" } },
        { nic: { contains: query, mode: "insensitive" } },
      ],
    } : {}),
    ...(admin.role === "HR_ADMINISTRATOR" ? {
      user: { isNot: { role: { in: ["ADMIN", "HR_ADMINISTRATOR"] } } },
    } : {}),
  };
  const [employees, total] = await Promise.all([
    database.employee.findMany({
      where,
        select: adminEmployeeListSelect,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    database.employee.count({ where }),
  ]);

  return { employees, total, page, pageSize, pageCount: Math.ceil(total / pageSize) };
}

export async function getEmployee(admin: EmployeeAdmin, employeeId: string, database: AdminEmployeeDatabase = prisma) {
  assertEmployeeManager(admin);
  const employee = await database.employee.findFirst({
    where: {
      OR: [{ userId: employeeId }, { id: employeeId }],
      ...(admin.role === "HR_ADMINISTRATOR" ? {
        user: { isNot: { role: { in: ["ADMIN", "HR_ADMINISTRATOR"] } } },
      } : {}),
    },
    select: adminEmployeeSelect,
  });
  if (!employee) throw new EmployeeNotFoundError();
  return employee;
}

export async function listEmployeeReportingOptions(admin: EmployeeAdmin, database: AdminEmployeeDatabase = prisma) {
  assertEmployeeManager(admin);
  const employees = await database.employee.findMany({
    where: { user: { is: { isActive: true, role: { in: ["SUPERVISOR", "DEPARTMENT_MANAGER"] } } } },
    select: {
      id: true,
      name: true,
      employeeId: true,
      departmentId: true,
      user: { select: { role: true } },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return {
    supervisors: employees.filter((employee) => employee.user?.role === "SUPERVISOR"),
    managers: employees.filter((employee) => employee.user?.role === "DEPARTMENT_MANAGER"),
  };
}

async function validateEmployeeReportingAssignments(
  assignments: { supervisorId?: string | null; managerId?: string | null; departmentId?: string | null },
  userId: string | undefined,
  database: EmployeeDatabase,
) {
  if (!assignments.supervisorId && !assignments.managerId) return;

  const current = userId
    ? await database.employee.findUnique({ where: { userId }, select: { id: true, departmentId: true } })
    : null;
  const departmentId = assignments.departmentId === undefined ? current?.departmentId : assignments.departmentId;
  const [supervisor, manager] = await Promise.all([
    assignments.supervisorId
      ? database.employee.findUnique({
          where: { id: assignments.supervisorId },
          select: { id: true, user: { select: { role: true, isActive: true } } },
        })
      : Promise.resolve(null),
    assignments.managerId
      ? database.employee.findUnique({
          where: { id: assignments.managerId },
          select: { id: true, departmentId: true, user: { select: { role: true, isActive: true } } },
        })
      : Promise.resolve(null),
  ]);

  if (assignments.supervisorId && (
    !supervisor
    || supervisor.id === current?.id
    || supervisor.user?.role !== "SUPERVISOR"
    || !supervisor.user.isActive
  )) {
    throw new EmployeeReportingAssignmentError("supervisor");
  }
  if (assignments.managerId && (
    !manager
    || manager.id === current?.id
    || manager.user?.role !== "DEPARTMENT_MANAGER"
    || !manager.user.isActive
    || !departmentId
    || manager.departmentId !== departmentId
  )) {
    throw new EmployeeReportingAssignmentError("manager");
  }
}

export async function createEmployee(admin: EmployeeAdmin, input: unknown, database: EmployeeDatabase = prisma) {
  assertEmployeeManager(admin);
  const parsed = createEmployeeSchema.parse(input);
  assertCanAssignRole(admin, parsed.role);
  const { password, nic, epfId, etfId, departmentId, designationId, shiftId, shiftIds, shiftEffectiveFrom, supervisorId, managerId, ...employeeFields } = parsed;
  const assignedShiftIds = shiftIds ?? (shiftId ? [shiftId] : []);
  const primaryShiftId = assignedShiftIds[0] ?? null;
  await validateEmployeeOrganizationAssignments({ departmentId, designationId }, database);
  await validateEmployeeShiftAssignments(assignedShiftIds, database);
  await validateEmployeeReportingAssignments({ supervisorId, managerId, departmentId }, undefined, database);
  const passwordHash = await hashPassword(password);

  return withDuplicateTranslation(() => database.user.create({
    data: {
      ...employeeFields,
      passwordHash,
      employee: {
        create: {
          name: employeeFields.name,
          employeeId: employeeFields.employeeCode,
          ...(nic !== undefined ? { nic } : {}),
          ...(epfId !== undefined ? { epfId } : {}),
          ...(etfId !== undefined ? { etfId } : {}),
          departmentId: departmentId ?? null,
          designationId: designationId ?? null,
          shiftId: primaryShiftId,
          ...(assignedShiftIds.length > 0 ? {
            shiftAssignments: {
              create: assignedShiftIds.map((assignedShiftId) => ({
                shiftId: assignedShiftId,
                effectiveFrom: shiftEffectiveFrom,
              })),
            },
          } : {}),
          supervisorId: supervisorId ?? null,
          managerId: managerId ?? null,
          profileOnboardingRequired: employeeFields.role !== "ADMIN",
        },
      },
    },
    select: publicEmployeeSelect,
  }));
}

export async function updateEmployee(admin: EmployeeAdmin, employeeId: string, input: unknown, database: EmployeeDatabase = prisma) {
  assertEmployeeManager(admin);
  const parsed = updateEmployeeSchema.parse(input);
  assertCanAssignRole(admin, parsed.role);
  await assertCanManageExistingAccount(admin, employeeId, database);
  const { password, nic, epfId, etfId, departmentId, designationId, shiftId, shiftIds, shiftEffectiveFrom, supervisorId, managerId, profile: profilePatch, ...employeeFields } = parsed;
  const assignedShiftIds = shiftIds !== undefined ? shiftIds : shiftId !== undefined ? (shiftId ? [shiftId] : []) : undefined;
  const primaryShiftId = assignedShiftIds?.[0] ?? null;
  await validateEmployeeOrganizationAssignments({ departmentId, designationId }, database);
  if (assignedShiftIds !== undefined) await validateEmployeeShiftAssignments(assignedShiftIds, database);
  await validateEmployeeReportingAssignments({ supervisorId, managerId, departmentId }, employeeId, database);
  const currentEmployee = assignedShiftIds !== undefined
    ? await database.employee.findUnique({
        where: { userId: employeeId },
        select: {
          shiftId: true,
          shiftAssignments: {
            select: { shiftId: true, effectiveFrom: true, effectiveTo: true, shift: { select: { workingDays: true } } },
          },
        },
      })
    : null;
  const activeShiftAssignments = currentEmployee?.shiftAssignments.filter(({ effectiveTo }) => effectiveTo === null) ?? [];
  const currentShiftIds = activeShiftAssignments.length
    ? activeShiftAssignments.map(({ shiftId: assignedId }) => assignedId)
    : currentEmployee?.shiftId ? [currentEmployee.shiftId] : [];
  const assignmentsChanged = assignedShiftIds !== undefined
    && [...assignedShiftIds].sort().join("\0") !== [...currentShiftIds].sort().join("\0");
  if (assignmentsChanged && currentEmployee) {
    const effectiveDate = shiftEffectiveFrom.toISOString().slice(0, 10);
    if (activeShiftAssignments.some(({ effectiveFrom }) =>
      effectiveDate <= effectiveFrom.toISOString().slice(0, 10),
    )) {
      throw new ShiftAssignmentConflictError();
    }
    const relevantEndedAssignments = currentEmployee.shiftAssignments.filter(({ effectiveTo }) =>
      effectiveTo !== null && effectiveTo.toISOString().slice(0, 10) >= effectiveDate,
    );
    const currentDays = new Set(relevantEndedAssignments.flatMap(({ shift }) => shift.workingDays));
    const requestedShifts = assignedShiftIds?.length
      ? await database.shift.findMany({
          where: { id: { in: assignedShiftIds } },
          select: { id: true, workingDays: true },
        })
      : [];
    if (requestedShifts.some(({ workingDays }) =>
      workingDays.some((weekday) => currentDays.has(weekday)),
    )) {
      throw new ShiftAssignmentConflictError();
    }
  }
  const passwordHash = password ? await hashPassword(password) : undefined;
  const profileData = definedProfileFields(profilePatch);
  const profileNeedsCompletion = employeeProfileRequiredFields.some((field) => profileData[field] === null);
  const employeeScalars = {
    name: employeeFields.name,
    ...(employeeFields.employeeCode !== undefined ? { employeeId: employeeFields.employeeCode } : {}),
    ...(nic !== undefined ? { nic } : {}),
    ...(epfId !== undefined ? { epfId } : {}),
    ...(etfId !== undefined ? { etfId } : {}),
    ...(departmentId !== undefined ? { departmentId } : {}),
    ...(designationId !== undefined ? { designationId } : {}),
    ...(assignedShiftIds !== undefined ? { shiftId: assignmentsChanged ? primaryShiftId : currentEmployee?.shiftId ?? primaryShiftId } : {}),
    ...(supervisorId !== undefined ? { supervisorId } : {}),
    ...(managerId !== undefined ? { managerId } : {}),
  };
  const employeeUpdate = {
    ...employeeScalars,
    ...(profileNeedsCompletion ? { profileOnboardingRequired: true, profileCompletedAt: null } : {}),
    ...(Object.keys(profileData).length > 0
      ? { profile: { upsert: { create: profileData, update: profileData } } }
      : {}),
    ...(assignmentsChanged ? {
      shiftAssignments: {
        updateMany: {
          where: { effectiveTo: null },
          data: { effectiveTo: new Date(shiftEffectiveFrom.getTime() - 86_400_000) },
        },
        create: assignedShiftIds!.map((assignedShiftId) => ({
          shiftId: assignedShiftId,
          effectiveFrom: shiftEffectiveFrom,
        })),
      },
    } : {}),
  };
  const employeeCreate = {
    ...employeeScalars,
    departmentId: departmentId ?? null,
    designationId: designationId ?? null,
    shiftId: primaryShiftId,
    supervisorId: supervisorId ?? null,
    managerId: managerId ?? null,
    profileOnboardingRequired: false,
    ...(Object.keys(profileData).length > 0 ? { profile: { create: profileData } } : {}),
    ...(assignedShiftIds !== undefined && assignedShiftIds.length > 0 ? {
      shiftAssignments: {
        create: assignedShiftIds.map((assignedShiftId) => ({
          shiftId: assignedShiftId,
          effectiveFrom: shiftEffectiveFrom,
        })),
      },
    } : {}),
  };

  return withDuplicateTranslation(() => database.user.update({
    where: { id: employeeId },
    data: {
      ...employeeFields,
      ...(passwordHash ? { passwordHash } : {}),
      employee: {
        upsert: {
          create: employeeCreate,
          update: employeeUpdate,
        },
      },
    },
    select: publicEmployeeSelect,
  }));
}

function definedProfileFields(profile: AdminEmployeeProfilePatch | undefined) {
  if (!profile) return {};
  const fields = Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined));
  if (fields.gender !== undefined && fields.gender !== "CUSTOM") fields.genderCustom = null;
  return fields;
}

export async function setEmployeeActive(admin: EmployeeAdmin, employeeId: string, isActive: boolean, database: EmployeeDatabase = prisma) {
  assertEmployeeManager(admin);
  await assertCanManageExistingAccount(admin, employeeId, database);
  return withDuplicateTranslation(() => database.user.update({
    where: { id: employeeId },
    data: { isActive },
    select: publicEmployeeSelect,
  }));
}