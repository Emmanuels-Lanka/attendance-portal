import "server-only";

import { Prisma, type PrismaClient, type Role } from "@prisma/client";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { calculateEmployeeLeaveWorkdays, LeaveWorkdayScheduleError, type LeaveHolidayResolver } from "@/lib/leave/workdays";
import {
  approvedLeaveUsageInputSchema,
  leaveEntitlementLookupSchema,
  leaveEntitlementSchema,
  leaveRequestedAmountSchema,
} from "@/lib/leave/validation";

type LeaveBalanceAdmin = { id: string; role: Role };
type LeaveBalanceEmployee = { id: string; role: Role };
type LeaveEntitlementReadDatabase = Pick<PrismaClient, "employee" | "leaveEntitlement">;
type OwnLeaveBalanceReadDatabase = Pick<PrismaClient, "employee" | "leaveEntitlement">;
type LeaveEntitlementTransactionDatabase = Pick<PrismaClient, "$transaction">;
type LeaveEntitlementManagementDatabase = Pick<PrismaClient, "employee" | "leaveType" | "leaveEntitlement" | "leaveRequest" | "holiday">;
type LeaveQuantity = Prisma.Decimal | string | number;

export class LeaveBalanceAccessError extends Error {
  constructor() {
    super("You do not have permission to access this Employee leave balance.");
    this.name = "LeaveBalanceAccessError";
  }
}

export class LeaveEntitlementAccessError extends Error {
  constructor() {
    super("Only HR Administrators and Super Administrators can manage Leave entitlements.");
    this.name = "LeaveEntitlementAccessError";
  }
}

export class LeaveEntitlementEmployeeNotFoundError extends Error {
  constructor() {
    super("Employee not found or not linked to an account.");
    this.name = "LeaveEntitlementEmployeeNotFoundError";
  }
}

export class LeaveEntitlementTypeNotFoundError extends Error {
  constructor() {
    super("Leave Type not found.");
    this.name = "LeaveEntitlementTypeNotFoundError";
  }
}

export class LeaveUsageSourceConflictError extends Error {
  constructor() {
    super("The same approved Leave source has conflicting records.");
    this.name = "LeaveUsageSourceConflictError";
  }
}

export class LeaveUsageEmployeeConflictError extends Error {
  constructor() {
    super("Approved Leave usage contains a record for a different Employee.");
    this.name = "LeaveUsageEmployeeConflictError";
  }
}

export class InsufficientLeaveBalanceError extends Error {
  constructor() {
    super("The requested Leave amount exceeds the available balance.");
    this.name = "InsufficientLeaveBalanceError";
  }
}

function assertCanManageLeave(admin: LeaveBalanceAdmin) {
  if (admin.role !== "ADMIN" && !hasPermission(admin.role, "leave:manage")) {
    throw new LeaveEntitlementAccessError();
  }
}

function canHrManageEmployee(employee: { user: { role: Role } | null }) {
  return employee.user !== null && ["EMPLOYEE", "SUPERVISOR", "DEPARTMENT_MANAGER"].includes(employee.user.role);
}

function assertCanManageEmployee(admin: LeaveBalanceAdmin, employee: { user: { role: Role } | null }) {
  if (admin.role === "HR_ADMINISTRATOR" && !canHrManageEmployee(employee)) {
    throw new LeaveEntitlementEmployeeNotFoundError();
  }
}

function assertEmployeeSelfAccess(actor: LeaveBalanceEmployee | null): asserts actor is LeaveBalanceEmployee {
  if (
    !actor
    || actor.role !== "EMPLOYEE"
    || !hasPermission(actor.role, "leave:balance:self:read")
  ) {
    throw new LeaveBalanceAccessError();
  }
}

function asDecimal(value: LeaveQuantity) {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

function asDatabaseDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

export async function listOwnLeaveBalanceCredits(
  actor: LeaveBalanceEmployee | null,
  database: OwnLeaveBalanceReadDatabase = prisma,
) {
  assertEmployeeSelfAccess(actor);
  const employee = await database.employee.findUnique({
    where: { userId: actor.id },
    select: { id: true },
  });
  if (!employee) throw new LeaveEntitlementEmployeeNotFoundError();

  const currentDate = new Date();
  const asOf = new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate()));
  return database.leaveEntitlement.findMany({
    where: {
      employeeId: employee.id,
      periodStart: { lte: asOf },
      periodEnd: { gte: asOf },
    },
    select: {
      id: true,
      employeeId: true,
      periodStart: true,
      periodEnd: true,
      openingBalance: true,
      entitlement: true,
      carryForward: true,
      leaveType: { select: { id: true, name: true } },
    },
    orderBy: [{ leaveType: { name: "asc" } }, { periodStart: "asc" }, { id: "asc" }],
  });
}

export async function listLeaveEntitlementEmployees(
  admin: LeaveBalanceAdmin,
  database: Pick<PrismaClient, "employee"> = prisma,
) {
  assertCanManageLeave(admin);
  return database.employee.findMany({
    where: { user: { is: { role: { in: ["EMPLOYEE", "SUPERVISOR", "DEPARTMENT_MANAGER"] } } } },
    select: { id: true, name: true, employeeId: true, department: { select: { name: true } } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

export async function listLeaveTypesForEntitlements(
  admin: LeaveBalanceAdmin,
  database: Pick<PrismaClient, "leaveType"> = prisma,
) {
  assertCanManageLeave(admin);
  return database.leaveType.findMany({
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

export function calculateAvailableLeaveBalance(
  credits: { openingBalance: LeaveQuantity; entitlement: LeaveQuantity; carryForward: LeaveQuantity },
  approvedUsage: LeaveQuantity,
) {
  return asDecimal(credits.openingBalance)
    .plus(asDecimal(credits.entitlement))
    .plus(asDecimal(credits.carryForward))
    .minus(asDecimal(approvedUsage));
}

export function assertLeaveBalanceCoversRequest(availableBalance: LeaveQuantity, requestedAmount: unknown) {
  const amount = leaveRequestedAmountSchema.parse(requestedAmount);
  if (amount.greaterThan(asDecimal(availableBalance))) throw new InsufficientLeaveBalanceError();
  return amount;
}

export async function getLeaveEntitlement(
  admin: LeaveBalanceAdmin,
  input: unknown,
  database: LeaveEntitlementReadDatabase = prisma,
) {
  assertCanManageLeave(admin);
  const { employeeId, leaveTypeId, periodStart, periodEnd } = leaveEntitlementLookupSchema.parse(input);
  const employee = await database.employee.findUnique({
    where: { id: employeeId },
    select: { user: { select: { role: true } } },
  });
  if (!employee) return null;
  if (admin.role === "HR_ADMINISTRATOR" && !canHrManageEmployee(employee)) return null;
  return database.leaveEntitlement.findUnique({
    where: {
      employeeId_leaveTypeId_periodStart_periodEnd: {
        employeeId,
        leaveTypeId,
        periodStart: asDatabaseDate(periodStart),
        periodEnd: asDatabaseDate(periodEnd),
      },
    },
  });
}

export async function setLeaveEntitlement(
  admin: LeaveBalanceAdmin,
  input: unknown,
  database: LeaveEntitlementTransactionDatabase = prisma,
) {
  assertCanManageLeave(admin);
  const parsed = leaveEntitlementSchema.parse(input);
  const { reason, ...credits } = parsed;

  return database.$transaction(async (transaction) => {
    const employee = await transaction.employee.findUnique({
      where: { id: parsed.employeeId },
      select: { id: true, userId: true, user: { select: { role: true } } },
    });
    if (!employee) throw new LeaveEntitlementEmployeeNotFoundError();
    assertCanManageEmployee(admin, employee);
    const leaveType = await transaction.leaveType.findUnique({
      where: { id: parsed.leaveTypeId },
      select: { id: true },
    });
    if (!leaveType) throw new LeaveEntitlementTypeNotFoundError();

    const uniqueKey = {
      employeeId_leaveTypeId_periodStart_periodEnd: {
        employeeId: parsed.employeeId,
        leaveTypeId: parsed.leaveTypeId,
        periodStart: asDatabaseDate(parsed.periodStart),
        periodEnd: asDatabaseDate(parsed.periodEnd),
      },
    };
    const previous = await transaction.leaveEntitlement.findUnique({ where: uniqueKey });
    const entitlement = await transaction.leaveEntitlement.upsert({
      where: uniqueKey,
      create: {
        ...credits,
        periodStart: asDatabaseDate(parsed.periodStart),
        periodEnd: asDatabaseDate(parsed.periodEnd),
      },
      update: {
        openingBalance: credits.openingBalance,
        entitlement: credits.entitlement,
        carryForward: credits.carryForward,
      },
    });
    const changedFields = previous
      ? (["openingBalance", "entitlement", "carryForward"] as const)
          .filter((field) => !new Prisma.Decimal(previous[field]).equals(parsed[field]))
      : ["openingBalance", "entitlement", "carryForward"];

    if (changedFields.length > 0) {
      await transaction.attendanceAuditLog.create({
        data: {
          employeeId: employee.userId,
          actorId: admin.id,
          actionType: previous ? "LEAVE_ENTITLEMENT_UPDATED" : "LEAVE_ENTITLEMENT_CREATED",
          ...(previous ? {
            previousValues: {
              employeeId: parsed.employeeId,
              leaveEntitlementId: entitlement.id,
              leaveTypeId: parsed.leaveTypeId,
              periodStart: parsed.periodStart,
              periodEnd: parsed.periodEnd,
              changedFields,
            },
          } : {}),
          newValues: {
            employeeId: parsed.employeeId,
            leaveEntitlementId: entitlement.id,
            leaveTypeId: parsed.leaveTypeId,
            periodStart: parsed.periodStart,
            periodEnd: parsed.periodEnd,
            changedFields,
          },
          reason,
        },
        select: { id: true },
      });
    }

    return entitlement;
  });
}

type LeaveBalanceCalculationDatabase = Pick<PrismaClient, "employee" | "leaveType" | "leaveRequest" | "holiday">;

async function calculateEntitlementBalance(
  input: { employeeId: string; leaveTypeId: string; periodStart: string; periodEnd: string },
  credits: { openingBalance: LeaveQuantity; entitlement: LeaveQuantity; carryForward: LeaveQuantity },
  database: LeaveBalanceCalculationDatabase,
) {
  const approvedRequests = await database.leaveRequest.findMany({
    where: {
      employeeId: input.employeeId,
      leaveTypeId: input.leaveTypeId,
      status: "APPROVED",
      startDate: { lte: asDatabaseDate(input.periodEnd) },
      endDate: { gte: asDatabaseDate(input.periodStart) },
    },
    select: { id: true, employeeId: true, leaveTypeId: true, status: true, startDate: true, endDate: true },
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
  });
  const holidayDates: string[] = [];
  const rangeStart = asDatabaseDate(input.periodStart);
  const rangeEnd = asDatabaseDate(input.periodEnd);
  const holidays = await database.holiday.findMany({
    where: { date: { gte: rangeStart, lte: rangeEnd } },
    select: { date: true, branch: true, applicableEmployeeGroups: true },
  });
  let scopedHolidaysUnresolved = false;
  for (const holiday of holidays) {
    if (holiday.branch || holiday.applicableEmployeeGroups.length > 0) scopedHolidaysUnresolved = true;
    else holidayDates.push(holiday.date.toISOString().slice(0, 10));
  }

  try {
    const approvedLeaveUsed = await calculateApprovedLeaveUsage({
      ...input,
      approvedLeaves: approvedRequests.map((request) => ({
        sourceId: request.id,
        employeeId: request.employeeId,
        leaveTypeId: request.leaveTypeId,
        status: request.status,
        startDate: request.startDate.toISOString().slice(0, 10),
        endDate: request.endDate.toISOString().slice(0, 10),
      })),
    }, {
      database,
      resolveHolidayDates: async ({ startDate, endDate }) => new Set(
        holidayDates.filter((date) => date >= startDate && date <= endDate),
      ),
    });
    return {
      approvedLeaveUsed,
      availableBalance: calculateAvailableLeaveBalance(credits, approvedLeaveUsed),
      scopedHolidaysUnresolved,
      scheduleUnavailable: false,
    };
  } catch (error) {
    if (!(error instanceof LeaveWorkdayScheduleError)) throw error;
    return {
      approvedLeaveUsed: null,
      availableBalance: null,
      scopedHolidaysUnresolved,
      scheduleUnavailable: true,
    };
  }
}

export async function getManagedLeaveBalance(
  admin: LeaveBalanceAdmin,
  input: unknown,
  database: LeaveEntitlementManagementDatabase = prisma,
) {
  assertCanManageLeave(admin);
  const parsed = leaveEntitlementLookupSchema.parse(input);
  const employee = await database.employee.findUnique({
    where: { id: parsed.employeeId },
    select: { id: true, name: true, employeeId: true, userId: true, user: { select: { role: true } }, department: { select: { name: true } } },
  });
  if (!employee) throw new LeaveEntitlementEmployeeNotFoundError();
  assertCanManageEmployee(admin, employee);

  const [leaveType, entitlement] = await Promise.all([
    database.leaveType.findUnique({ where: { id: parsed.leaveTypeId }, select: { id: true, name: true } }),
    database.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_periodStart_periodEnd: {
          employeeId: parsed.employeeId,
          leaveTypeId: parsed.leaveTypeId,
          periodStart: asDatabaseDate(parsed.periodStart),
          periodEnd: asDatabaseDate(parsed.periodEnd),
        },
      },
    }),
  ]);
  if (!leaveType) throw new LeaveEntitlementTypeNotFoundError();

  const balance = entitlement
    ? await calculateEntitlementBalance(parsed, entitlement, database)
    : null;
  return {
    employee: {
      id: employee.id,
      name: employee.name,
      employeeId: employee.employeeId,
      department: employee.department,
    },
    leaveType,
    entitlement,
    balance,
  };
}

export async function listOwnLeaveBalances(
  actor: LeaveBalanceEmployee | null,
  database: LeaveEntitlementManagementDatabase = prisma,
) {
  assertEmployeeSelfAccess(actor);
  const credits = await listOwnLeaveBalanceCredits(actor, database);
  return Promise.all(credits.map(async (entitlement) => ({
    ...entitlement,
    balance: await calculateEntitlementBalance({
      employeeId: entitlement.employeeId,
      leaveTypeId: entitlement.leaveType.id,
      periodStart: entitlement.periodStart.toISOString().slice(0, 10),
      periodEnd: entitlement.periodEnd.toISOString().slice(0, 10),
    }, entitlement, database),
  })));
}

export async function calculateApprovedLeaveUsage(input: {
  employeeId: string;
  leaveTypeId: string;
  periodStart: string;
  periodEnd: string;
  approvedLeaves: unknown;
}, dependencies: {
  resolveHolidayDates: LeaveHolidayResolver;
  database?: Pick<PrismaClient, "employee" | "leaveType">;
}) {
  const { employeeId, leaveTypeId, periodStart, periodEnd } = leaveEntitlementLookupSchema.parse(input);
  const employee = await (dependencies.database ?? prisma).employee.findUnique({
    where: { id: employeeId },
    select: { id: true, userId: true },
  });
  if (!employee?.userId) throw new LeaveEntitlementEmployeeNotFoundError();

  const leaveType = await (dependencies.database ?? prisma).leaveType.findUnique({
    where: { id: leaveTypeId },
    select: { id: true },
  });
  if (!leaveType) throw new LeaveEntitlementTypeNotFoundError();

  const candidates = approvedLeaveUsageInputSchema.parse(input.approvedLeaves);
  const uniqueBySource = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    if (candidate.employeeId !== employeeId) throw new LeaveUsageEmployeeConflictError();
    const existing = uniqueBySource.get(candidate.sourceId);
    if (existing && (
      existing.leaveTypeId !== candidate.leaveTypeId
      || existing.status !== candidate.status
      || existing.startDate !== candidate.startDate
      || existing.endDate !== candidate.endDate
    )) {
      throw new LeaveUsageSourceConflictError();
    }
    uniqueBySource.set(candidate.sourceId, candidate);
  }

  let total = 0;
  for (const leave of uniqueBySource.values()) {
    if (leave.status !== "APPROVED" || leave.leaveTypeId !== leaveTypeId) continue;
    const startDate = leave.startDate > periodStart ? leave.startDate : periodStart;
    const endDate = leave.endDate < periodEnd ? leave.endDate : periodEnd;
    if (startDate > endDate) continue;
    total += await calculateEmployeeLeaveWorkdays(
      { employeeUserId: employee.userId, startDate, endDate },
      { resolveHolidayDates: dependencies.resolveHolidayDates, database: dependencies.database },
    );
  }
  return new Prisma.Decimal(total);
}
