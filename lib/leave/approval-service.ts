import "server-only";

import { LeaveRequestStatus, type Prisma, type PrismaClient, type Role } from "@prisma/client";
import { z } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import {
  getActiveManagerDepartmentId,
  lockActiveManagerDepartmentId,
  lockEmployeeForApproval,
} from "@/lib/organization/manager-scope";

type LeaveReviewer = { id: string; role: Role } | null;
type LeaveApprovalDatabase = Pick<PrismaClient, "$transaction" | "leaveRequest" | "attendanceAuditLog" | "notification">;

export const leaveDecisionSchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  reason: z.preprocess(
    (value) => value === "" || value === null ? undefined : value,
    z.string().trim().max(500).optional(),
  ),
});

export class LeaveApprovalAccessError extends Error {
  constructor() {
    super("Only an assigned Supervisor or Department Manager can review Leave requests in this workflow.");
    this.name = "LeaveApprovalAccessError";
  }
}

export class LeaveApprovalNotFoundError extends Error {
  constructor() {
    super("Leave request not found.");
    this.name = "LeaveApprovalNotFoundError";
  }
}

export class LeaveApprovalScopeError extends Error {
  constructor() {
    super("This Leave request is not assigned to you for review.");
    this.name = "LeaveApprovalScopeError";
  }
}

export class LeaveApprovalStageError extends Error {
  constructor() {
    super("This Leave request is no longer pending Supervisor review.");
    this.name = "LeaveApprovalStageError";
  }
}

function assertSupervisor(actor: LeaveReviewer): asserts actor is Exclude<LeaveReviewer, null> {
  if (
    !actor
    || actor.role !== "SUPERVISOR"
    || !hasPermission(actor.role, "leave:approve")
  ) {
    throw new LeaveApprovalAccessError();
  }
}

const reviewRequestSelect = {
  id: true,
  employeeId: true,
  leaveTypeId: true,
  startDate: true,
  endDate: true,
  reason: true,
  status: true,
  currentApprovalStage: true,
  currentApproverId: true,
  createdAt: true,
  reviewedById: true,
  reviewedAt: true,
  decisionReason: true,
  employee: {
    select: {
      id: true,
      name: true,
      employeeId: true,
      userId: true,
      supervisor: { select: { userId: true, user: { select: { role: true, isActive: true } } } },
      manager: { select: { userId: true, user: { select: { role: true, isActive: true } } } },
    },
  },
  leaveType: { select: { id: true, name: true } },
} satisfies Prisma.LeaveRequestSelect;

export async function listSupervisorLeaveRequests(
  actor: LeaveReviewer,
  database: Pick<PrismaClient, "leaveRequest"> = prisma,
) {
  assertSupervisor(actor);
  const where: Prisma.LeaveRequestWhereInput = {
    status: LeaveRequestStatus.PENDING,
    currentApprovalStage: "SUPERVISOR",
    currentApproverId: actor.id,
    employee: { supervisor: { userId: actor.id, user: { isActive: true, role: "SUPERVISOR" } } },
  };
  return database.leaveRequest.findMany({
    where,
    select: reviewRequestSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

function assertManager(actor: LeaveReviewer): asserts actor is Exclude<LeaveReviewer, null> {
  if (!actor || actor.role !== "DEPARTMENT_MANAGER" || !hasPermission(actor.role, "leave:approve")) {
    throw new LeaveApprovalAccessError();
  }
}

export async function listManagerLeaveRequests(
  actor: LeaveReviewer,
  database: Pick<PrismaClient, "employee" | "leaveRequest"> = prisma,
) {
  assertManager(actor);
  const departmentId = await getActiveManagerDepartmentId(database, actor.id);
  if (!departmentId) return [];
  return database.leaveRequest.findMany({
    where: {
      status: LeaveRequestStatus.PENDING,
      currentApprovalStage: "MANAGER",
      currentApproverId: actor.id,
      employee: {
        departmentId,
        manager: { userId: actor.id, user: { isActive: true, role: "DEPARTMENT_MANAGER" } },
      },
    },
    select: reviewRequestSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function decideSupervisorLeaveRequest(
  actor: LeaveReviewer,
  leaveRequestId: string,
  input: unknown,
  database: LeaveApprovalDatabase = prisma,
) {
  assertSupervisor(actor);
  const decision = leaveDecisionSchema.parse(input);

  return database.$transaction(async (transaction) => {
    const requestReference = await transaction.leaveRequest.findUnique({
      where: { id: leaveRequestId },
      select: { employeeId: true },
    });
    if (!requestReference) throw new LeaveApprovalNotFoundError();
    await lockEmployeeForApproval(transaction, requestReference.employeeId);
    const request = await transaction.leaveRequest.findUnique({
      where: { id: leaveRequestId },
      select: {
        id: true,
        employeeId: true,
        startDate: true,
        endDate: true,
        status: true,
        currentApprovalStage: true,
        currentApproverId: true,
        leaveType: { select: { name: true } },
        employee: {
          select: {
            userId: true,
            supervisor: { select: { userId: true, user: { select: { role: true, isActive: true } } } },
            manager: { select: { userId: true, user: { select: { role: true, isActive: true } } } },
          },
        },
      },
    });
    if (!request) throw new LeaveApprovalNotFoundError();
    if (
      request.status !== LeaveRequestStatus.PENDING
      || request.currentApprovalStage !== "SUPERVISOR"
    ) {
      throw new LeaveApprovalStageError();
    }
    if (
      !request.employee.userId
      || request.employee.supervisor?.userId !== actor.id
      || request.employee.supervisor.user?.role !== "SUPERVISOR"
      || !request.employee.supervisor.user.isActive
      || request.currentApproverId !== actor.id
    ) {
      throw new LeaveApprovalScopeError();
    }

    const assignedManager = request.employee.manager;
    const nextStage = decision.action === "APPROVE"
      && assignedManager?.userId
      && assignedManager.user?.role === "DEPARTMENT_MANAGER"
      && assignedManager.user.isActive
      ? "MANAGER"
      : null;
    const status = decision.action === "REJECT" ? LeaveRequestStatus.REJECTED
      : nextStage ? LeaveRequestStatus.PENDING : LeaveRequestStatus.APPROVED;
    const currentApproverId = nextStage ? assignedManager!.userId : null;
    const reviewedAt = new Date();
    const updated = await transaction.leaveRequest.updateMany({
      where: {
        id: request.id,
        status: LeaveRequestStatus.PENDING,
        currentApprovalStage: "SUPERVISOR",
        currentApproverId: actor.id,
        employee: { supervisor: { userId: actor.id, user: { isActive: true, role: "SUPERVISOR" } } },
      },
      data: {
        status,
        currentApprovalStage: nextStage,
        currentApproverId,
        reviewedById: actor.id,
        reviewedAt,
        decisionReason: decision.reason ?? null,
      },
    });
    if (updated.count !== 1) throw new LeaveApprovalStageError();

    const actionType = decision.action === "REJECT"
      ? "LEAVE_REQUEST_REJECTED"
      : nextStage ? "LEAVE_REQUEST_SUPERVISOR_APPROVED" : "LEAVE_REQUEST_APPROVED";
    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: request.employee.userId,
        actorId: actor.id,
        actionType,
        previousValues: {
          leaveRequestId: request.id,
          status: request.status,
          currentApprovalStage: request.currentApprovalStage,
          currentApproverId: request.currentApproverId,
        },
        newValues: {
          leaveRequestId: request.id,
          status,
          currentApprovalStage: nextStage,
          currentApproverId,
          reviewedById: actor.id,
          reviewedAt: reviewedAt.toISOString(),
        },
        reason: decision.reason ?? null,
      },
      select: { id: true },
    });

    if (nextStage && currentApproverId) {
      await transaction.notification.create({
        data: {
          userId: currentApproverId,
          title: "Leave request pending",
          message: `A Leave request for ${request.startDate.toISOString().slice(0, 10)} to ${request.endDate.toISOString().slice(0, 10)} is awaiting your review.`,
          type: "LEAVE_REQUEST_PENDING",
        },
        select: { id: true },
      });
    } else {
      const outcome = status === LeaveRequestStatus.APPROVED ? "approved" : "rejected";
      await transaction.notification.create({
        data: {
          userId: request.employee.userId,
          title: `Leave request ${outcome}`,
          message: `Your ${request.leaveType.name} request for ${request.startDate.toISOString().slice(0, 10)} to ${request.endDate.toISOString().slice(0, 10)} was ${outcome}.`,
          type: status === LeaveRequestStatus.APPROVED ? "LEAVE_REQUEST_APPROVED" : "LEAVE_REQUEST_REJECTED",
        },
        select: { id: true },
      });
    }

    return { id: request.id, status, currentApprovalStage: nextStage, reviewedById: actor.id, reviewedAt };
  });
}

export async function decideManagerLeaveRequest(
  actor: LeaveReviewer,
  leaveRequestId: string,
  input: unknown,
  database: LeaveApprovalDatabase = prisma,
) {
  assertManager(actor);
  const decision = leaveDecisionSchema.parse(input);

  return database.$transaction(async (transaction) => {
    const departmentId = await lockActiveManagerDepartmentId(transaction, actor.id);
    if (!departmentId) throw new LeaveApprovalScopeError();
    const requestReference = await transaction.leaveRequest.findUnique({
      where: { id: leaveRequestId },
      select: { employeeId: true },
    });
    if (!requestReference) throw new LeaveApprovalNotFoundError();
    await lockEmployeeForApproval(transaction, requestReference.employeeId);
    const request = await transaction.leaveRequest.findUnique({
      where: { id: leaveRequestId },
      select: {
        id: true,
        employeeId: true,
        startDate: true,
        endDate: true,
        status: true,
        currentApprovalStage: true,
        currentApproverId: true,
        leaveType: { select: { name: true } },
        employee: {
          select: {
            userId: true,
            departmentId: true,
            manager: { select: { userId: true, user: { select: { role: true, isActive: true } } } },
          },
        },
      },
    });
    if (!request) throw new LeaveApprovalNotFoundError();
    if (
      request.status !== LeaveRequestStatus.PENDING
      || request.currentApprovalStage !== "MANAGER"
      || request.currentApproverId !== actor.id
    ) throw new LeaveApprovalStageError();
    if (
      !request.employee.userId
      || request.employee.manager?.userId !== actor.id
      || request.employee.manager.user?.role !== "DEPARTMENT_MANAGER"
      || !request.employee.manager.user.isActive
      || request.employee.departmentId !== departmentId
    ) throw new LeaveApprovalScopeError();

    const status = decision.action === "APPROVE" ? LeaveRequestStatus.APPROVED : LeaveRequestStatus.REJECTED;
    const reviewedAt = new Date();
    const updated = await transaction.leaveRequest.updateMany({
      where: {
        id: request.id,
        status: LeaveRequestStatus.PENDING,
        currentApprovalStage: "MANAGER",
        currentApproverId: actor.id,
        employee: {
          departmentId,
          manager: { userId: actor.id, user: { role: "DEPARTMENT_MANAGER", isActive: true } },
        },
      },
      data: {
        status,
        currentApprovalStage: null,
        currentApproverId: null,
        reviewedById: actor.id,
        reviewedAt,
        decisionReason: decision.reason ?? null,
      },
    });
    if (updated.count !== 1) throw new LeaveApprovalStageError();

    const outcome = decision.action === "APPROVE" ? "approved" : "rejected";
    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: request.employee.userId,
        actorId: actor.id,
        actionType: decision.action === "APPROVE" ? "LEAVE_REQUEST_APPROVED" : "LEAVE_REQUEST_REJECTED",
        previousValues: {
          leaveRequestId: request.id,
          status: request.status,
          currentApprovalStage: request.currentApprovalStage,
          currentApproverId: request.currentApproverId,
        },
        newValues: {
          leaveRequestId: request.id,
          status,
          currentApprovalStage: null,
          currentApproverId: null,
          reviewedById: actor.id,
          reviewedAt: reviewedAt.toISOString(),
        },
        reason: decision.reason ?? null,
      },
      select: { id: true },
    });
    await transaction.notification.create({
      data: {
        userId: request.employee.userId,
        title: `Leave request ${outcome}`,
        message: `Your ${request.leaveType.name} request for ${request.startDate.toISOString().slice(0, 10)} to ${request.endDate.toISOString().slice(0, 10)} was ${outcome}.`,
        type: decision.action === "APPROVE" ? "LEAVE_REQUEST_APPROVED" : "LEAVE_REQUEST_REJECTED",
      },
      select: { id: true },
    });
    return { id: request.id, status, currentApprovalStage: null, reviewedById: actor.id, reviewedAt };
  });
}
