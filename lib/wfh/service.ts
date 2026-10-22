import "server-only";

import {
  WorkFromHomeApprovalStage,
  WorkFromHomeRequestStatus,
  type Prisma,
  type PrismaClient,
  type Role,
} from "@prisma/client";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { isValid } from "date-fns";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import {
  getActiveManagerDepartmentId,
  lockActiveManagerDepartmentId,
  lockEmployeeForApproval,
} from "@/lib/organization/manager-scope";
import { workFromHomeDecisionSchema, workFromHomeRequestInputSchema } from "./validation";

type WorkFromHomeActor = { id: string; role: Role; timeZone: string } | null;
type WorkFromHomeRequestDatabase = Pick<
  PrismaClient,
  "employee" | "workFromHomeRequest" | "attendanceAuditLog" | "notification" | "$transaction"
>;
type WorkFromHomeApprovalDatabase = Pick<PrismaClient, "$transaction" | "workFromHomeRequest">;

export class WorkFromHomeRequestAccessError extends Error {
  constructor() {
    super("You do not have permission to access this WFH request.");
    this.name = "WorkFromHomeRequestAccessError";
  }
}

export class WorkFromHomeEmployeeNotFoundError extends Error {
  constructor() {
    super("No Employee record is linked to this account.");
    this.name = "WorkFromHomeEmployeeNotFoundError";
  }
}

export class WorkFromHomeApproverNotFoundError extends Error {
  constructor(stage: "Supervisor" | "Manager") {
    super(`An active assigned ${stage} is required for this WFH workflow.`);
    this.name = "WorkFromHomeApproverNotFoundError";
  }
}

export class WorkFromHomeRequestNotFoundError extends Error {
  constructor() {
    super("WFH request not found.");
    this.name = "WorkFromHomeRequestNotFoundError";
  }
}

export class WorkFromHomeApprovalScopeError extends Error {
  constructor() {
    super("This WFH request is not assigned to you for review.");
    this.name = "WorkFromHomeApprovalScopeError";
  }
}

export class WorkFromHomeApprovalStageError extends Error {
  constructor() {
    super("This WFH request is no longer awaiting your review.");
    this.name = "WorkFromHomeApprovalStageError";
  }
}

export class WorkFromHomeRequestTimeError extends Error {
  constructor() {
    super("Enter valid start and end times in your configured timezone; the end time must be later than the start time.");
    this.name = "WorkFromHomeRequestTimeError";
  }
}

function assertEmployee(actor: WorkFromHomeActor): asserts actor is Exclude<WorkFromHomeActor, null> {
  if (!actor || actor.role !== "EMPLOYEE" || !hasPermission(actor.role, "wfh:submit")) {
    throw new WorkFromHomeRequestAccessError();
  }
}

function assertApprover(actor: WorkFromHomeActor): asserts actor is Exclude<WorkFromHomeActor, null> {
  if (
    !actor
    || (actor.role !== "SUPERVISOR" && actor.role !== "DEPARTMENT_MANAGER")
    || !hasPermission(actor.role, "wfh:approve")
  ) {
    throw new WorkFromHomeRequestAccessError();
  }
}

function toRequestInstants(date: string, startTime: string, endTime: string, timeZone: string) {
  const startAt = fromZonedTime(`${date}T${startTime}:00`, timeZone);
  const endAt = fromZonedTime(`${date}T${endTime}:00`, timeZone);
  if (
    !isValid(startAt)
    || !isValid(endAt)
    || formatInTimeZone(startAt, timeZone, "yyyy-MM-dd'T'HH:mm:ss") !== `${date}T${startTime}:00`
    || formatInTimeZone(endAt, timeZone, "yyyy-MM-dd'T'HH:mm:ss") !== `${date}T${endTime}:00`
    || endAt <= startAt
  ) {
    throw new WorkFromHomeRequestTimeError();
  }
  return { startAt, endAt };
}

const ownRequestSelect = {
  id: true,
  date: true,
  startAt: true,
  endAt: true,
  reason: true,
  workLocation: true,
  status: true,
  currentApprovalStage: true,
  decisionReason: true,
  createdAt: true,
  reviewedAt: true,
} satisfies Prisma.WorkFromHomeRequestSelect;

const reviewRequestSelect = {
  ...ownRequestSelect,
  employee: {
    select: {
      id: true,
      name: true,
      employeeId: true,
      userId: true,
      user: { select: { timeZone: true } },
      supervisor: { select: { userId: true, user: { select: { role: true, isActive: true } } } },
      manager: { select: { userId: true, user: { select: { role: true, isActive: true } } } },
    },
  },
} satisfies Prisma.WorkFromHomeRequestSelect;

export async function submitOwnWorkFromHomeRequest(
  actor: WorkFromHomeActor,
  input: unknown,
  database: WorkFromHomeRequestDatabase = prisma,
) {
  assertEmployee(actor);
  const parsed = workFromHomeRequestInputSchema.parse(input);
  const { startAt, endAt } = toRequestInstants(parsed.date, parsed.startTime, parsed.endTime, actor.timeZone);

  return database.$transaction(async (transaction) => {
    const employee = await transaction.employee.findUnique({
      where: { userId: actor.id },
      select: {
        id: true,
        userId: true,
        supervisor: { select: { userId: true, user: { select: { role: true, isActive: true } } } },
        manager: { select: { userId: true, user: { select: { role: true, isActive: true } } } },
      },
    });
    if (!employee?.userId) throw new WorkFromHomeEmployeeNotFoundError();
    const supervisor = employee.supervisor;
    if (!supervisor?.userId || supervisor.user?.role !== "SUPERVISOR" || !supervisor.user.isActive) {
      throw new WorkFromHomeApproverNotFoundError("Supervisor");
    }
    const manager = employee.manager;
    if (!manager?.userId || manager.user?.role !== "DEPARTMENT_MANAGER" || !manager.user.isActive) {
      throw new WorkFromHomeApproverNotFoundError("Manager");
    }

    const request = await transaction.workFromHomeRequest.create({
      data: {
        employeeId: employee.id,
        date: new Date(`${parsed.date}T00:00:00.000Z`),
        startAt,
        endAt,
        reason: parsed.reason,
        workLocation: parsed.workLocation,
        status: WorkFromHomeRequestStatus.PENDING,
        currentApprovalStage: WorkFromHomeApprovalStage.SUPERVISOR,
        currentApproverId: supervisor.userId,
      },
      select: ownRequestSelect,
    });
    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: actor.id,
        actorId: actor.id,
        actionType: "WFH_REQUEST_SUBMITTED",
        newValues: {
          workFromHomeRequestId: request.id,
          date: parsed.date,
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          workLocation: parsed.workLocation,
          status: WorkFromHomeRequestStatus.PENDING,
          currentApprovalStage: WorkFromHomeApprovalStage.SUPERVISOR,
        },
        reason: parsed.reason,
      },
      select: { id: true },
    });
    await transaction.notification.create({
      data: {
        userId: supervisor.userId,
        title: "WFH request pending",
        message: `A WFH request for ${parsed.date} is awaiting your review.`,
        type: "WFH_REQUEST_PENDING",
      },
      select: { id: true },
    });
    return request;
  });
}

export async function listOwnWorkFromHomeRequests(
  actor: WorkFromHomeActor,
  database: Pick<PrismaClient, "employee" | "workFromHomeRequest"> = prisma,
) {
  assertEmployee(actor);
  const employee = await database.employee.findUnique({
    where: { userId: actor.id },
    select: { id: true },
  });
  if (!employee) throw new WorkFromHomeEmployeeNotFoundError();
  return database.workFromHomeRequest.findMany({
    where: { employeeId: employee.id },
    select: ownRequestSelect,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
}

export async function listApprovedWorkFromHomeForAttendance(
  actor: WorkFromHomeActor,
  database: Pick<PrismaClient, "workFromHomeRequest"> = prisma,
) {
  if (!actor) throw new WorkFromHomeRequestAccessError();
  return database.workFromHomeRequest.findMany({
    where: { employee: { userId: actor.id }, status: WorkFromHomeRequestStatus.APPROVED },
    select: { id: true, date: true, startAt: true, endAt: true, workLocation: true },
    orderBy: [{ date: "desc" }, { startAt: "asc" }],
  });
}

export async function listWorkFromHomeRequestsForReview(
  actor: WorkFromHomeActor,
  database: Pick<PrismaClient, "employee" | "workFromHomeRequest"> = prisma,
) {
  assertApprover(actor);
  const managerDepartmentId = actor.role === "DEPARTMENT_MANAGER"
    ? await getActiveManagerDepartmentId(database, actor.id)
    : null;
  if (actor.role === "DEPARTMENT_MANAGER" && !managerDepartmentId) return [];
  const stage = actor.role === "SUPERVISOR"
    ? WorkFromHomeApprovalStage.SUPERVISOR
    : WorkFromHomeApprovalStage.MANAGER;
  return database.workFromHomeRequest.findMany({
    where: {
      status: WorkFromHomeRequestStatus.PENDING,
      currentApprovalStage: stage,
      currentApproverId: actor.id,
      employee: actor.role === "SUPERVISOR"
        ? { supervisor: { userId: actor.id, user: { role: "SUPERVISOR", isActive: true } } }
        : {
            departmentId: managerDepartmentId,
            manager: { userId: actor.id, user: { role: "DEPARTMENT_MANAGER", isActive: true } },
          },
    },
    select: reviewRequestSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function decideWorkFromHomeRequest(
  actor: WorkFromHomeActor,
  requestId: string,
  input: unknown,
  database: WorkFromHomeApprovalDatabase = prisma,
) {
  assertApprover(actor);
  const decision = workFromHomeDecisionSchema.parse(input);
  const stage = actor.role === "SUPERVISOR"
    ? WorkFromHomeApprovalStage.SUPERVISOR
    : WorkFromHomeApprovalStage.MANAGER;

  return database.$transaction(async (transaction) => {
    const managerDepartmentId = actor.role === "DEPARTMENT_MANAGER"
      ? await lockActiveManagerDepartmentId(transaction, actor.id)
      : null;
    if (actor.role === "DEPARTMENT_MANAGER" && !managerDepartmentId) throw new WorkFromHomeApprovalScopeError();
    const requestReference = await transaction.workFromHomeRequest.findUnique({
      where: { id: requestId },
      select: { employeeId: true },
    });
    if (!requestReference) throw new WorkFromHomeRequestNotFoundError();
    await lockEmployeeForApproval(transaction, requestReference.employeeId);
    const request = await transaction.workFromHomeRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        employeeId: true,
        date: true,
        status: true,
        currentApprovalStage: true,
        currentApproverId: true,
        employee: {
          select: {
            userId: true,
            departmentId: true,
            supervisor: { select: { userId: true, user: { select: { role: true, isActive: true } } } },
            manager: { select: { userId: true, user: { select: { role: true, isActive: true } } } },
          },
        },
      },
    });
    if (!request) throw new WorkFromHomeRequestNotFoundError();
    if (request.employee.userId === actor.id) throw new WorkFromHomeApprovalScopeError();
    if (
      request.status !== WorkFromHomeRequestStatus.PENDING
      || request.currentApprovalStage !== stage
      || request.currentApproverId !== actor.id
    ) {
      throw new WorkFromHomeApprovalStageError();
    }
    const assigned = actor.role === "SUPERVISOR"
      ? request.employee.supervisor?.userId === actor.id
        && request.employee.supervisor.user?.role === "SUPERVISOR"
        && request.employee.supervisor.user.isActive
      : request.employee.manager?.userId === actor.id
        && request.employee.manager.user?.role === "DEPARTMENT_MANAGER"
        && request.employee.manager.user.isActive
        && request.employee.departmentId === managerDepartmentId;
    if (!assigned) throw new WorkFromHomeApprovalScopeError();
    if (actor.role === "SUPERVISOR" && decision.action === "APPROVE" && (
      !request.employee.manager?.userId
      || request.employee.manager.user?.role !== "DEPARTMENT_MANAGER"
      || !request.employee.manager.user.isActive
    )) {
      throw new WorkFromHomeApproverNotFoundError("Manager");
    }

    const nextStage = actor.role === "SUPERVISOR" && decision.action === "APPROVE"
      ? WorkFromHomeApprovalStage.MANAGER
      : null;
    const status = decision.action === "REJECT" ? WorkFromHomeRequestStatus.REJECTED
      : nextStage ? WorkFromHomeRequestStatus.PENDING : WorkFromHomeRequestStatus.APPROVED;
    const currentApproverId = nextStage ? request.employee.manager!.userId : null;
    const reviewedAt = new Date();
    const updated = await transaction.workFromHomeRequest.updateMany({
      where: {
        id: request.id,
        status: WorkFromHomeRequestStatus.PENDING,
        currentApprovalStage: stage,
        currentApproverId: actor.id,
        employee: actor.role === "SUPERVISOR"
          ? { supervisor: { userId: actor.id, user: { role: "SUPERVISOR", isActive: true } } }
          : {
              departmentId: managerDepartmentId,
              manager: { userId: actor.id, user: { role: "DEPARTMENT_MANAGER", isActive: true } },
            },
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
    if (updated.count !== 1) throw new WorkFromHomeApprovalStageError();

    const actionType = decision.action === "REJECT"
      ? "WFH_REQUEST_REJECTED"
      : nextStage ? "WFH_REQUEST_SUPERVISOR_APPROVED" : "WFH_REQUEST_APPROVED";
    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: request.employee.userId,
        actorId: actor.id,
        actionType,
        previousValues: {
          workFromHomeRequestId: request.id,
          status: request.status,
          currentApprovalStage: request.currentApprovalStage,
          currentApproverId: request.currentApproverId,
        },
        newValues: {
          workFromHomeRequestId: request.id,
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
          title: "WFH request pending",
          message: `A WFH request for ${request.date.toISOString().slice(0, 10)} is awaiting your review.`,
          type: "WFH_REQUEST_PENDING",
        },
        select: { id: true },
      });
    } else if (request.employee.userId) {
      const outcome = status === WorkFromHomeRequestStatus.APPROVED ? "approved" : "rejected";
      await transaction.notification.create({
        data: {
          userId: request.employee.userId,
          title: `WFH request ${outcome}`,
          message: `Your WFH request for ${request.date.toISOString().slice(0, 10)} was ${outcome}.`,
          type: status === WorkFromHomeRequestStatus.APPROVED ? "WFH_REQUEST_APPROVED" : "WFH_REQUEST_REJECTED",
        },
        select: { id: true },
      });
    }
    return { id: request.id, status, currentApprovalStage: nextStage, reviewedById: actor.id, reviewedAt };
  });
}
