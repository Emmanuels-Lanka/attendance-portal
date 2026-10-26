import "server-only";

import { LeaveCancellationStatus, LeaveRequestStatus, type Prisma, type PrismaClient, type Role } from "@prisma/client";
import { z } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import {
  getActiveManagerDepartmentId,
  lockActiveManagerDepartmentId,
  lockEmployeeForApproval,
} from "@/lib/organization/manager-scope";
import { recalculateAttendanceMonthsFromDatesInTransaction } from "@/lib/attendance/engine-service";

type CancellationActor = { id: string; role: Role } | null;
type CancellationDatabase = Pick<PrismaClient, "$transaction" | "employee" | "leaveRequest">;
type CancellationReviewDatabase = Pick<PrismaClient, "$transaction" | "employee" | "leaveRequest" | "attendanceAuditLog" | "notification">;

export const leaveCancellationInputSchema = z.object({
  reason: z.string().trim().min(1, "A cancellation reason is required.").max(500),
});

export const leaveCancellationDecisionSchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  reason: z.preprocess(
    (value) => value === "" || value === null ? undefined : value,
    z.string().trim().max(500).optional(),
  ),
});

export class LeaveCancellationAccessError extends Error {
  constructor(message = "You do not have permission to cancel this Leave request.") {
    super(message);
    this.name = "LeaveCancellationAccessError";
  }
}

export class LeaveCancellationNotFoundError extends Error {
  constructor() {
    super("Leave request not found.");
    this.name = "LeaveCancellationNotFoundError";
  }
}

export class LeaveCancellationStageError extends Error {
  constructor() {
    super("This cancellation is no longer awaiting your review.");
    this.name = "LeaveCancellationStageError";
  }
}

export class LeaveCancellationScopeError extends Error {
  constructor() {
    super("This cancellation is not assigned to you for review.");
    this.name = "LeaveCancellationScopeError";
  }
}

function assertEmployee(actor: CancellationActor): asserts actor is Exclude<CancellationActor, null> {
  if (!actor || actor.role !== "EMPLOYEE" || !hasPermission(actor.role, "leave:request:self:read")) {
    throw new LeaveCancellationAccessError();
  }
}

function assertSupervisor(actor: CancellationActor): asserts actor is Exclude<CancellationActor, null> {
  if (!actor || actor.role !== "SUPERVISOR" || !hasPermission(actor.role, "leave:approve")) {
    throw new LeaveCancellationAccessError("Only an assigned Supervisor can review Leave cancellations.");
  }
}

function assertManager(actor: CancellationActor): asserts actor is Exclude<CancellationActor, null> {
  if (!actor || actor.role !== "DEPARTMENT_MANAGER" || !hasPermission(actor.role, "leave:approve")) {
    throw new LeaveCancellationAccessError("Only an assigned Department Manager can review Leave cancellations.");
  }
}

const cancellationReviewSelect = {
  id: true,
  employeeId: true,
  startDate: true,
  endDate: true,
  reason: true,
  status: true,
  cancellationStatus: true,
  cancellationReason: true,
  cancellationApprovalStage: true,
  cancellationCurrentApproverId: true,
  cancellationRequestedById: true,
  employee: {
    select: {
      userId: true,
      name: true,
      employeeId: true,
      departmentId: true,
      supervisor: { select: { userId: true, user: { select: { role: true, isActive: true } } } },
      manager: { select: { userId: true, user: { select: { role: true, isActive: true } } } },
    },
  },
  leaveType: { select: { name: true } },
} satisfies Prisma.LeaveRequestSelect;

export async function requestOwnLeaveCancellation(
  actor: CancellationActor,
  leaveRequestId: string,
  input: unknown,
  database: CancellationDatabase = prisma,
) {
  assertEmployee(actor);
  const { reason } = leaveCancellationInputSchema.parse(input);
  return database.$transaction(async (transaction) => {
    const employee = await transaction.employee.findUnique({
      where: { userId: actor.id },
      select: { id: true, userId: true, supervisor: { select: { userId: true, user: { select: { role: true, isActive: true } } } } },
    });
    if (!employee?.userId) throw new LeaveCancellationNotFoundError();
    await lockEmployeeForApproval(transaction, employee.id);
    const request = await transaction.leaveRequest.findFirst({
      where: { id: leaveRequestId, employeeId: employee.id },
      select: {
        id: true,
        employeeId: true,
        startDate: true,
        endDate: true,
        status: true,
        cancellationStatus: true,
        cancellationApprovalStage: true,
      },
    });
    if (!request) throw new LeaveCancellationNotFoundError();
    if (
      request.cancellationStatus === LeaveCancellationStatus.PENDING
      || (request.status !== LeaveRequestStatus.PENDING && request.status !== LeaveRequestStatus.APPROVED)
    ) {
      throw new LeaveCancellationStageError();
    }

    const immediate = request.status === LeaveRequestStatus.PENDING;
    const supervisor = employee.supervisor;
    if (!immediate && (
      !supervisor?.userId
      || supervisor.user?.role !== "SUPERVISOR"
      || !supervisor.user.isActive
      || supervisor.userId === actor.id
    )) {
      throw new LeaveCancellationAccessError("An active assigned Supervisor is required to review this cancellation.");
    }
    const requestedAt = new Date();
    const updated = await transaction.leaveRequest.updateMany({
      where: {
        id: request.id,
        status: request.status,
        cancellationStatus: request.cancellationStatus,
      },
      data: {
        ...(immediate ? { status: LeaveRequestStatus.CANCELLED } : {}),
        cancellationStatus: immediate ? LeaveCancellationStatus.APPROVED : LeaveCancellationStatus.PENDING,
        cancellationReason: reason,
        cancellationRequestedById: actor.id,
        cancellationRequestedAt: requestedAt,
        cancellationApprovalStage: immediate ? null : "SUPERVISOR",
        cancellationCurrentApproverId: immediate ? null : supervisor!.userId,
        cancellationReviewedById: immediate ? actor.id : null,
        cancellationReviewedAt: immediate ? requestedAt : null,
        cancellationDecisionReason: immediate ? reason : null,
        ...(immediate ? { currentApprovalStage: null, currentApproverId: null } : {}),
      },
    });
    if (updated.count !== 1) throw new LeaveCancellationStageError();

    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: employee.userId,
        actorId: actor.id,
        actionType: immediate ? "LEAVE_REQUEST_CANCELLED" : "LEAVE_CANCELLATION_REQUESTED",
        previousValues: { leaveRequestId: request.id, status: request.status },
        newValues: {
          leaveRequestId: request.id,
          status: immediate ? LeaveRequestStatus.CANCELLED : request.status,
          cancellationStatus: immediate ? LeaveCancellationStatus.APPROVED : LeaveCancellationStatus.PENDING,
          cancellationApprovalStage: immediate ? null : "SUPERVISOR",
          cancellationCurrentApproverId: immediate ? null : supervisor!.userId,
          requestedAt: requestedAt.toISOString(),
        },
        reason,
      },
      select: { id: true },
    });
    const notificationUserId = immediate ? actor.id : supervisor?.userId;
    if (!notificationUserId) {
      throw new LeaveCancellationAccessError("An active assigned Supervisor is required to receive this cancellation.");
    }
    await transaction.notification.create({
      data: immediate
        ? {
            userId: notificationUserId,
            title: "Leave request cancelled",
            message: `Your pending Leave request for ${request.startDate.toISOString().slice(0, 10)} to ${request.endDate.toISOString().slice(0, 10)} was cancelled.`,
            type: "LEAVE_REQUEST_CANCELLED",
          }
        : {
            userId: notificationUserId,
            title: "Leave cancellation pending",
            message: `A Leave cancellation for ${request.startDate.toISOString().slice(0, 10)} to ${request.endDate.toISOString().slice(0, 10)} is awaiting your review.`,
            type: "LEAVE_CANCELLATION_PENDING",
          },
      select: { id: true },
    });
    return { id: request.id, status: immediate ? LeaveRequestStatus.CANCELLED : request.status, cancellationStatus: immediate ? LeaveCancellationStatus.APPROVED : LeaveCancellationStatus.PENDING };
  });
}

export async function listSupervisorLeaveCancellations(
  actor: CancellationActor,
  database: Pick<PrismaClient, "leaveRequest"> = prisma,
) {
  assertSupervisor(actor);
  return database.leaveRequest.findMany({
    where: {
      status: LeaveRequestStatus.APPROVED,
      cancellationStatus: LeaveCancellationStatus.PENDING,
      cancellationApprovalStage: "SUPERVISOR",
      cancellationCurrentApproverId: actor.id,
      employee: { supervisor: { userId: actor.id, user: { isActive: true, role: "SUPERVISOR" } } },
    },
    select: cancellationReviewSelect,
    orderBy: [{ cancellationRequestedAt: "asc" }, { id: "asc" }],
  });
}

export async function listManagerLeaveCancellations(
  actor: CancellationActor,
  database: Pick<PrismaClient, "employee" | "leaveRequest"> = prisma,
) {
  assertManager(actor);
  const departmentId = await getActiveManagerDepartmentId(database, actor.id);
  if (!departmentId) return [];
  return database.leaveRequest.findMany({
    where: {
      status: LeaveRequestStatus.APPROVED,
      cancellationStatus: LeaveCancellationStatus.PENDING,
      cancellationApprovalStage: "MANAGER",
      cancellationCurrentApproverId: actor.id,
      employee: {
        departmentId,
        manager: { userId: actor.id, user: { isActive: true, role: "DEPARTMENT_MANAGER" } },
      },
    },
    select: cancellationReviewSelect,
    orderBy: [{ cancellationRequestedAt: "asc" }, { id: "asc" }],
  });
}

async function decideCancellation(
  stage: "SUPERVISOR" | "MANAGER",
  actor: Exclude<CancellationActor, null>,
  leaveRequestId: string,
  input: unknown,
  database: CancellationReviewDatabase,
) {
  const decision = leaveCancellationDecisionSchema.parse(input);
  return database.$transaction(async (transaction) => {
    const departmentId = stage === "MANAGER"
      ? await lockActiveManagerDepartmentId(transaction, actor.id)
      : null;
    if (stage === "MANAGER" && !departmentId) throw new LeaveCancellationScopeError();
    const reference = await transaction.leaveRequest.findUnique({
      where: { id: leaveRequestId },
      select: { employeeId: true },
    });
    if (!reference) throw new LeaveCancellationNotFoundError();
    await lockEmployeeForApproval(transaction, reference.employeeId);
    const request = await transaction.leaveRequest.findUnique({
      where: { id: leaveRequestId },
      select: {
        ...cancellationReviewSelect,
        startDate: true,
        endDate: true,
        employee: {
          select: {
            userId: true,
            name: true,
            employeeId: true,
            departmentId: true,
            user: { select: { timeZone: true } },
            supervisor: { select: { userId: true, user: { select: { role: true, isActive: true } } } },
            manager: { select: { userId: true, user: { select: { role: true, isActive: true } } } },
          },
        },
      },
    });
    if (!request) throw new LeaveCancellationNotFoundError();
    if (
      request.status !== LeaveRequestStatus.APPROVED
      || request.cancellationStatus !== LeaveCancellationStatus.PENDING
      || request.cancellationApprovalStage !== stage
      || request.cancellationCurrentApproverId !== actor.id
    ) throw new LeaveCancellationStageError();
    if (!request.employee.userId || request.employee.userId === actor.id) throw new LeaveCancellationScopeError();
    const assignment = stage === "SUPERVISOR" ? request.employee.supervisor : request.employee.manager;
    if (
      assignment?.userId !== actor.id
      || assignment.user?.isActive !== true
      || assignment.user.role !== (stage === "SUPERVISOR" ? "SUPERVISOR" : "DEPARTMENT_MANAGER")
      || (stage === "MANAGER" && request.employee.departmentId !== departmentId)
    ) throw new LeaveCancellationScopeError();

    const nextManager = decision.action === "APPROVE" && stage === "SUPERVISOR"
      && request.employee.manager?.userId
      && request.employee.manager.user?.role === "DEPARTMENT_MANAGER"
      && request.employee.manager.user.isActive
      && request.employee.manager.userId !== request.employee.userId
      ? request.employee.manager.userId
      : null;
    const finalized = decision.action === "REJECT" || stage === "MANAGER" || !nextManager;
    const cancelled = decision.action === "APPROVE" && finalized;
    const reviewedAt = new Date();
    const updated = await transaction.leaveRequest.updateMany({
      where: {
        id: request.id,
        status: LeaveRequestStatus.APPROVED,
        cancellationStatus: LeaveCancellationStatus.PENDING,
        cancellationApprovalStage: stage,
        cancellationCurrentApproverId: actor.id,
      },
      data: {
        ...(cancelled ? { status: LeaveRequestStatus.CANCELLED, currentApprovalStage: null, currentApproverId: null } : {}),
        cancellationStatus: finalized
          ? cancelled ? LeaveCancellationStatus.APPROVED : LeaveCancellationStatus.REJECTED
          : LeaveCancellationStatus.PENDING,
        cancellationApprovalStage: nextManager ? "MANAGER" : null,
        cancellationCurrentApproverId: nextManager,
        cancellationReviewedById: finalized ? actor.id : null,
        cancellationReviewedAt: finalized ? reviewedAt : null,
        cancellationDecisionReason: finalized ? decision.reason ?? null : null,
      },
    });
    if (updated.count !== 1) throw new LeaveCancellationStageError();

    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: request.employee.userId,
        actorId: actor.id,
        actionType: nextManager ? "LEAVE_CANCELLATION_SUPERVISOR_APPROVED"
          : cancelled ? "LEAVE_REQUEST_CANCELLED"
            : "LEAVE_CANCELLATION_REJECTED",
        previousValues: {
          leaveRequestId: request.id,
          status: request.status,
          cancellationStatus: request.cancellationStatus,
          cancellationApprovalStage: request.cancellationApprovalStage,
          cancellationCurrentApproverId: request.cancellationCurrentApproverId,
        },
        newValues: {
          leaveRequestId: request.id,
          status: cancelled ? LeaveRequestStatus.CANCELLED : request.status,
          cancellationStatus: finalized
            ? cancelled ? LeaveCancellationStatus.APPROVED : LeaveCancellationStatus.REJECTED
            : LeaveCancellationStatus.PENDING,
          cancellationApprovalStage: nextManager ? "MANAGER" : null,
          cancellationCurrentApproverId: nextManager,
          reviewedById: finalized ? actor.id : null,
          reviewedAt: finalized ? reviewedAt.toISOString() : null,
        },
        reason: decision.reason ?? request.cancellationReason,
      },
      select: { id: true },
    });

    if (nextManager) {
      await transaction.notification.create({
        data: {
          userId: nextManager,
          title: "Leave cancellation pending",
          message: `A Leave cancellation for ${request.startDate.toISOString().slice(0, 10)} to ${request.endDate.toISOString().slice(0, 10)} is awaiting your review.`,
          type: "LEAVE_CANCELLATION_PENDING",
        },
        select: { id: true },
      });
    } else {
      await transaction.notification.create({
        data: {
          userId: request.employee.userId,
          title: cancelled ? "Leave request cancelled" : "Leave cancellation rejected",
          message: cancelled
            ? `Your Leave request for ${request.startDate.toISOString().slice(0, 10)} to ${request.endDate.toISOString().slice(0, 10)} was cancelled.`
            : `Your Leave cancellation for ${request.startDate.toISOString().slice(0, 10)} to ${request.endDate.toISOString().slice(0, 10)} was rejected; the approved Leave remains active.`,
          type: cancelled ? "LEAVE_REQUEST_CANCELLED" : "LEAVE_CANCELLATION_REJECTED",
        },
        select: { id: true },
      });
    }
    if (cancelled) {
      const timeZone = request.employee.user?.timeZone;
      if (!timeZone) throw new Error("Employee timezone is required to recalculate attendance after Leave cancellation.");
      const affectedDates: string[] = [];
      for (let date = new Date(`${request.startDate.toISOString().slice(0, 10)}T00:00:00.000Z`); date <= request.endDate; date.setUTCDate(date.getUTCDate() + 1)) {
        affectedDates.push(date.toISOString().slice(0, 10));
      }
      await recalculateAttendanceMonthsFromDatesInTransaction(transaction, {
        employeeRecordId: request.employeeId,
        employeeUserId: request.employee.userId,
        timeZone,
        affectedDates,
      });
    }
    return {
      id: request.id,
      status: cancelled ? LeaveRequestStatus.CANCELLED : request.status,
      cancellationStatus: finalized
        ? cancelled ? LeaveCancellationStatus.APPROVED : LeaveCancellationStatus.REJECTED
        : LeaveCancellationStatus.PENDING,
      cancellationApprovalStage: nextManager ? "MANAGER" : null,
    };
  });
}

export async function decideSupervisorLeaveCancellation(
  actor: CancellationActor,
  leaveRequestId: string,
  input: unknown,
  database: CancellationReviewDatabase = prisma,
) {
  assertSupervisor(actor);
  return decideCancellation("SUPERVISOR", actor, leaveRequestId, input, database);
}

export async function decideManagerLeaveCancellation(
  actor: CancellationActor,
  leaveRequestId: string,
  input: unknown,
  database: CancellationReviewDatabase = prisma,
) {
  assertManager(actor);
  return decideCancellation("MANAGER", actor, leaveRequestId, input, database);
}
