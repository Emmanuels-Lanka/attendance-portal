import "server-only";

import type { Prisma, PrismaClient, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { leaveTypeListQuerySchema, leaveTypeRecordSchema } from "@/lib/leave/validation";

type LeaveTypeAdmin = { role: Role };
type LeaveTypeDatabase = Pick<PrismaClient, "leaveType">;
type LeaveTypeAuditDatabase = Pick<PrismaClient, "attendanceAuditLog">;

export class LeaveTypeAccessError extends Error {
  constructor() {
    super("Only administrators can manage Leave Types.");
    this.name = "LeaveTypeAccessError";
  }
}

export class LeaveTypeNotFoundError extends Error {
  constructor() {
    super("Leave Type not found.");
    this.name = "LeaveTypeNotFoundError";
  }
}

export class LeaveTypeInUseError extends Error {
  constructor() {
    super("This Leave Type cannot be deleted while Leave records reference it.");
    this.name = "LeaveTypeInUseError";
  }
}

function assertAdmin(admin: LeaveTypeAdmin) {
  if (admin.role !== "ADMIN") throw new LeaveTypeAccessError();
}

function translateLeaveTypeError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "P2003") throw new LeaveTypeInUseError();
    if (error.code === "P2025") throw new LeaveTypeNotFoundError();
  }
  throw error;
}

export async function listLeaveTypes(
  admin: LeaveTypeAdmin,
  input: unknown = {},
  database: LeaveTypeDatabase = prisma,
) {
  assertAdmin(admin);
  const { query, page, pageSize } = leaveTypeListQuerySchema.parse(input);
  const where: Prisma.LeaveTypeWhereInput = query ? { name: { contains: query, mode: "insensitive" } } : {};
  const [items, total] = await Promise.all([
    database.leaveType.findMany({
      where,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, name: true, durationMode: true, createdAt: true, updatedAt: true },
    }),
    database.leaveType.count({ where }),
  ]);
  return { items, total, page, pageSize, pageCount: Math.ceil(total / pageSize) };
}

export async function getLeaveType(admin: LeaveTypeAdmin, id: string, database: LeaveTypeDatabase = prisma) {
  assertAdmin(admin);
  const leaveType = await database.leaveType.findUnique({
    where: { id },
    select: { id: true, name: true, durationMode: true, createdAt: true, updatedAt: true },
  });
  if (!leaveType) throw new LeaveTypeNotFoundError();
  return leaveType;
}

export async function createLeaveType(
  admin: LeaveTypeAdmin,
  input: unknown,
  database: LeaveTypeDatabase = prisma,
) {
  assertAdmin(admin);
  const { name, durationMode } = leaveTypeRecordSchema.parse(input);
  return database.leaveType.create({ data: { name, durationMode }, select: { id: true, name: true, durationMode: true } });
}

export async function updateLeaveType(
  admin: LeaveTypeAdmin,
  id: string,
  input: unknown,
  database: LeaveTypeDatabase = prisma,
) {
  assertAdmin(admin);
  const { name, durationMode } = leaveTypeRecordSchema.parse(input);
  try {
    return await database.leaveType.update({ where: { id }, data: { name, durationMode }, select: { id: true, name: true, durationMode: true } });
  } catch (error) {
    translateLeaveTypeError(error);
  }
}

export async function deleteLeaveType(admin: LeaveTypeAdmin, id: string, database: LeaveTypeDatabase = prisma) {
  assertAdmin(admin);
  try {
    return await database.leaveType.delete({ where: { id }, select: { id: true, name: true } });
  } catch (error) {
    translateLeaveTypeError(error);
  }
}

export async function writeLeaveTypeAuditEvent(
  database: LeaveTypeAuditDatabase,
  input: {
    leaveTypeId: string;
    actorId: string;
    operation: "CREATED" | "UPDATED" | "DELETED";
  },
) {
  const changedFields = input.operation === "DELETED" ? ["id"] : ["name", "durationMode"];
  await database.attendanceAuditLog.create({
    data: {
      actorId: input.actorId,
      actionType: `LEAVE_TYPE_${input.operation}`,
      ...(input.operation === "CREATED" ? {} : { previousValues: { leaveTypeId: input.leaveTypeId, changedFields } }),
      ...(input.operation === "DELETED" ? {} : { newValues: { leaveTypeId: input.leaveTypeId, changedFields } }),
      reason: `Administrator ${input.operation.toLowerCase()} Leave Type; field values are omitted.`,
    },
    select: { id: true },
  });
}
