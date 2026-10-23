import "server-only";

import { LeaveRequestStatus, type Prisma, type PrismaClient, type Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/auth/permissions";
import { leaveRequestInputSchema, leaveRequestListQuerySchema } from "@/lib/leave/validation";

type LeaveRequestActor = { id: string; role: Role };
type LeaveRequestDatabase = Pick<
  PrismaClient,
  "employee" | "leaveType" | "employeeDocument" | "leaveRequest" | "attendanceAuditLog" | "notification" | "$transaction"
>;

export class LeaveRequestAccessError extends Error {
  constructor() {
    super("You do not have permission to access this Leave request.");
    this.name = "LeaveRequestAccessError";
  }
}

export class LeaveRequestEmployeeNotFoundError extends Error {
  constructor() {
    super("No Employee record is linked to this account.");
    this.name = "LeaveRequestEmployeeNotFoundError";
  }
}

export class LeaveRequestLeaveTypeNotFoundError extends Error {
  constructor() {
    super("Leave Type not found.");
    this.name = "LeaveRequestLeaveTypeNotFoundError";
  }
}

export class LeaveRequestAttachmentNotFoundError extends Error {
  constructor() {
    super("The selected attachment was not found for this Employee.");
    this.name = "LeaveRequestAttachmentNotFoundError";
  }
}

export class LeaveRequestNotFoundError extends Error {
  constructor() {
    super("Leave request not found.");
    this.name = "LeaveRequestNotFoundError";
  }
}

export class LeaveRequestSupervisorNotFoundError extends Error {
  constructor() {
    super("An active assigned Supervisor is required to submit a Leave request.");
    this.name = "LeaveRequestSupervisorNotFoundError";
  }
}

function assertPermission(actor: LeaveRequestActor | null, permission: "leave:submit" | "leave:request:self:read"): asserts actor is LeaveRequestActor {
  if (!actor || actor.role === "ADMIN" || !hasPermission(actor.role, permission)) throw new LeaveRequestAccessError();
  if (permission === "leave:submit" && actor.role !== "EMPLOYEE") throw new LeaveRequestAccessError();
}

async function getOwnEmployee(actor: LeaveRequestActor, database: Pick<PrismaClient, "employee">) {
  const employee = await database.employee.findUnique({
    where: { userId: actor.id },
    select: {
      id: true,
      userId: true,
      supervisor: {
        select: {
          userId: true,
          user: { select: { role: true, isActive: true } },
        },
      },
      manager: {
        select: {
          userId: true,
          user: { select: { role: true, isActive: true } },
        },
      },
    },
  });
  if (!employee?.userId) throw new LeaveRequestEmployeeNotFoundError();
  return employee;
}

function asDatabaseDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

const ownRequestSelect = {
  id: true,
  leaveTypeId: true,
  startDate: true,
  endDate: true,
  reason: true,
  attachmentDocumentId: true,
  status: true,
  currentApprovalStage: true,
  currentApproverId: true,
  decisionReason: true,
  reviewedById: true,
  reviewedAt: true,
  createdAt: true,
  updatedAt: true,
  leaveType: { select: { id: true, name: true } },
} satisfies Prisma.LeaveRequestSelect;

export async function submitOwnLeaveRequest(
  actor: LeaveRequestActor | null,
  input: unknown,
  database: LeaveRequestDatabase = prisma,
) {
  assertPermission(actor, "leave:submit");
  const parsed = leaveRequestInputSchema.parse(input);

  return database.$transaction(async (transaction) => {
    const employee = await getOwnEmployee(actor, transaction);
    const supervisor = employee.supervisor;
    if (
      !supervisor?.userId
      || supervisor.user?.role !== "SUPERVISOR"
      || !supervisor.user.isActive
    ) {
      throw new LeaveRequestSupervisorNotFoundError();
    }
    const leaveType = await transaction.leaveType.findUnique({
      where: { id: parsed.leaveTypeId },
      select: { id: true },
    });
    if (!leaveType) throw new LeaveRequestLeaveTypeNotFoundError();

    if (parsed.attachmentDocumentId) {
      const attachment = await transaction.employeeDocument.findFirst({
        where: { id: parsed.attachmentDocumentId, employeeId: employee.id },
        select: { id: true },
      });
      if (!attachment) throw new LeaveRequestAttachmentNotFoundError();
    }

    const request = await transaction.leaveRequest.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: parsed.leaveTypeId,
        startDate: asDatabaseDate(parsed.startDate),
        endDate: asDatabaseDate(parsed.endDate),
        reason: parsed.reason,
        attachmentDocumentId: parsed.attachmentDocumentId,
        status: LeaveRequestStatus.PENDING,
        currentApprovalStage: "SUPERVISOR",
        currentApproverId: supervisor.userId,
      },
      select: ownRequestSelect,
    });
    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: employee.userId,
        actorId: actor.id,
        actionType: "LEAVE_REQUEST_SUBMITTED",
        newValues: {
          leaveRequestId: request.id,
          leaveTypeId: request.leaveTypeId,
          startDate: parsed.startDate,
          endDate: parsed.endDate,
          attachmentProvided: parsed.attachmentDocumentId !== null,
        },
        reason: "Employee submitted a Leave request; request reason and attachment details are omitted.",
      },
      select: { id: true },
    });
    await transaction.notification.create({
      data: {
        userId: supervisor.userId,
        title: "Leave request pending",
        message: `A Leave request for ${parsed.startDate} to ${parsed.endDate} is awaiting your review.`,
        type: "LEAVE_REQUEST_PENDING",
      },
      select: { id: true },
    });
    return request;
  });
}

export async function listOwnLeaveRequests(
  actor: LeaveRequestActor | null,
  input: unknown = {},
  database: LeaveRequestDatabase = prisma,
) {
  assertPermission(actor, "leave:request:self:read");
  const employee = await getOwnEmployee(actor, database);
  const { page, pageSize } = leaveRequestListQuerySchema.parse(input);
  const where: Prisma.LeaveRequestWhereInput = { employeeId: employee.id };
  const [items, total] = await Promise.all([
    database.leaveRequest.findMany({
      where,
      select: ownRequestSelect,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    database.leaveRequest.count({ where }),
  ]);
  return { items, total, page, pageSize, pageCount: Math.ceil(total / pageSize) };
}

export async function getOwnLeaveRequest(
  actor: LeaveRequestActor | null,
  requestId: string,
  database: LeaveRequestDatabase = prisma,
) {
  assertPermission(actor, "leave:request:self:read");
  const employee = await getOwnEmployee(actor, database);
  const request = await database.leaveRequest.findFirst({
    where: { id: requestId, employeeId: employee.id },
    select: ownRequestSelect,
  });
  if (!request) throw new LeaveRequestNotFoundError();
  return request;
}
