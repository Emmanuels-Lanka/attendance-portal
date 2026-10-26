import "server-only";

import { Prisma, type PrismaClient, type Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/auth/permissions";
import { shiftListQuerySchema, shiftRecordSchema } from "@/lib/shifts/validation";

type ShiftAdmin = { role: Role };
type ShiftDatabase = Pick<PrismaClient, "shift" | "employee" | "attendanceDaily">;
type ShiftAuditDatabase = Pick<PrismaClient, "attendanceAuditLog">;

export class ShiftAccessError extends Error {
  constructor() {
    super("You do not have permission to manage shifts.");
    this.name = "ShiftAccessError";
  }
}

export class ShiftNotFoundError extends Error {
  constructor() {
    super("Shift not found.");
    this.name = "ShiftNotFoundError";
  }
}

export class ShiftAssignmentConflictError extends Error {
  constructor() {
    super("Assigned shifts cannot have overlapping working days.");
    this.name = "ShiftAssignmentConflictError";
  }
}

export class ShiftWorkingDaysConfigurationError extends Error {
  constructor() {
    super("Configure at least one working weekday for every assigned Shift.");
    this.name = "ShiftWorkingDaysConfigurationError";
  }
}

export class ShiftInUseError extends Error {
  constructor() {
    super("This shift cannot be deleted while employees or attendance records reference it.");
    this.name = "ShiftInUseError";
  }
}

function assertCanManageShifts(actor: ShiftAdmin) {
  if (!hasPermission(actor.role, "shift:manage")) throw new ShiftAccessError();
}

function translateShiftError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "P2003") throw new ShiftInUseError();
    if (error.code === "P2025") throw new ShiftNotFoundError();
  }
  throw error;
}

const shiftSelect = {
  id: true,
  name: true,
  startTime: true,
  endTime: true,
  breakStartTime: true,
  breakDurationMinutes: true,
  gracePeriodMinutes: true,
  lateThresholdMinutes: true,
  earlyDepartureThresholdMinutes: true,
  minimumWorkingHours: true,
  overtimeEligible: true,
  roundingRules: true,
  workingDays: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ShiftSelect;

const editableShiftFields = [
  "name",
  "startTime",
  "endTime",
  "breakStartTime",
  "breakDurationMinutes",
  "gracePeriodMinutes",
  "lateThresholdMinutes",
  "earlyDepartureThresholdMinutes",
  "minimumWorkingHours",
  "overtimeEligible",
  "roundingRules",
  "workingDays",
] as const;

function comparableValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value) ?? String(value);
}

export function getChangedShiftFields(
  before: Record<(typeof editableShiftFields)[number], unknown>,
  after: Record<(typeof editableShiftFields)[number], unknown>,
) {
  return editableShiftFields.filter((field) => comparableValue(before[field]) !== comparableValue(after[field]));
}

function shiftData(input: unknown): Prisma.ShiftUncheckedCreateInput {
  const parsed = shiftRecordSchema.parse(input);
  return {
    ...parsed,
    minimumWorkingHours: parsed.minimumWorkingHours,
    roundingRules: parsed.roundingRules === null ? Prisma.DbNull : parsed.roundingRules as Prisma.InputJsonValue,
  };
}

export async function listShifts(
  admin: ShiftAdmin,
  input: unknown = {},
  database: ShiftDatabase = prisma,
) {
  assertCanManageShifts(admin);
  const { query, page, pageSize } = shiftListQuerySchema.parse(input);
  const where: Prisma.ShiftWhereInput = query ? { name: { contains: query, mode: "insensitive" } } : {};
  const [items, total] = await Promise.all([
    database.shift.findMany({
      where,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: shiftSelect,
    }),
    database.shift.count({ where }),
  ]);
  return { items, total, page, pageSize, pageCount: Math.ceil(total / pageSize) };
}

export async function getShift(admin: ShiftAdmin, id: string, database: ShiftDatabase = prisma) {
  assertCanManageShifts(admin);
  const shift = await database.shift.findUnique({
    where: { id },
    select: shiftSelect,
  });
  if (!shift) throw new ShiftNotFoundError();
  return shift;
}

export async function listShiftOptions(admin: ShiftAdmin, database: ShiftDatabase = prisma) {
  if (admin.role !== "ADMIN" && !hasPermission(admin.role, "shift:manage")) {
    throw new ShiftAccessError();
  }
  return database.shift.findMany({
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });
}

export async function createShift(
  admin: ShiftAdmin,
  input: unknown,
  database: ShiftDatabase = prisma,
) {
  assertCanManageShifts(admin);
  return database.shift.create({ data: shiftData(input), select: shiftSelect });
}

export async function updateShift(
  admin: ShiftAdmin,
  id: string,
  input: unknown,
  database: ShiftDatabase = prisma,
) {
  assertCanManageShifts(admin);
  const { name, startTime, endTime, breakDurationMinutes, gracePeriodMinutes, lateThresholdMinutes,
    breakStartTime, earlyDepartureThresholdMinutes, minimumWorkingHours, overtimeEligible, roundingRules, workingDays } =
    shiftRecordSchema.parse(input);
  try {
    return await database.shift.update({
      where: { id },
      data: {
        name,
        startTime,
        endTime,
        breakStartTime,
        breakDurationMinutes,
        gracePeriodMinutes,
        lateThresholdMinutes,
        earlyDepartureThresholdMinutes,
        minimumWorkingHours,
        overtimeEligible,
        roundingRules: roundingRules === null ? Prisma.DbNull : roundingRules as Prisma.InputJsonValue,
        workingDays,
      },
      select: shiftSelect,
    });
  } catch (error) {
    translateShiftError(error);
  }
}

export async function deleteShift(admin: ShiftAdmin, id: string, database: ShiftDatabase = prisma) {
  assertCanManageShifts(admin);
  try {
    const [employeeReferences, attendanceReferences] = await Promise.all([
      database.employee.count({ where: { shiftId: id } }),
      database.attendanceDaily.count({ where: { shiftId: id } }),
    ]);
    if (employeeReferences > 0 || attendanceReferences > 0) throw new ShiftInUseError();
    return await database.shift.delete({ where: { id }, select: { id: true, name: true } });
  } catch (error) {
    if (error instanceof ShiftInUseError) throw error;
    translateShiftError(error);
  }
}

export async function validateEmployeeShiftAssignment(
  shiftId: string | null | undefined,
  database: Pick<PrismaClient, "shift">,
) {
  if (shiftId && !(await database.shift.findUnique({ where: { id: shiftId }, select: { id: true } }))) {
    throw new ShiftNotFoundError();
  }
}

export async function validateEmployeeShiftAssignments(
  shiftIds: readonly string[],
  database: Pick<PrismaClient, "shift"> = prisma,
) {
  if (shiftIds.length === 0) return;
  const shifts = await database.shift.findMany({
    where: { id: { in: [...shiftIds] } },
    select: { id: true, workingDays: true },
  });
  if (shifts.length !== shiftIds.length) throw new ShiftNotFoundError();

  const assignedWeekdays = new Set<string>();
  for (const shift of shifts) {
    const workingDays = shift.workingDays;
    if (workingDays.length === 0) throw new ShiftWorkingDaysConfigurationError();
    if (workingDays.some((weekday) => assignedWeekdays.has(weekday))) {
      throw new ShiftAssignmentConflictError();
    }
    workingDays.forEach((weekday) => assignedWeekdays.add(weekday));
  }
}

export async function writeShiftAuditEvent(
  database: ShiftAuditDatabase,
  input: {
    shiftId: string;
    actorId: string;
    operation: "CREATED" | "UPDATED" | "DELETED";
    changedFields?: string[];
  },
) {
  const changedFields = input.changedFields ?? (input.operation === "DELETED" ? ["id"] : ["name"]);
  await database.attendanceAuditLog.create({
    data: {
      actorId: input.actorId,
      actionType: `SHIFT_${input.operation}`,
      ...(input.operation === "CREATED" ? {} : { previousValues: { shiftId: input.shiftId, changedFields } }),
      ...(input.operation === "DELETED" ? {} : { newValues: { shiftId: input.shiftId, changedFields } }),
      reason: `An authorized administrator ${input.operation.toLowerCase()} a shift; field values are omitted.`,
    },
    select: { id: true },
  });
}
