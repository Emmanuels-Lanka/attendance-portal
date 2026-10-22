import "server-only";

import {
  OvertimeApprovalStage,
  OvertimeRequestStatus,
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
import { overtimeDecisionSchema, overtimeRequestInputSchema } from "./validation";

type OvertimeActor = { id: string; role: Role; timeZone: string } | null;
type OvertimeRequestDatabase = Pick<
  PrismaClient,
  "employee" | "overtimeRequest" | "attendanceAuditLog" | "$transaction"
>;
type OvertimeApprovalDatabase = Pick<PrismaClient, "$transaction" | "overtimeRequest">;

export class OvertimeRequestAccessError extends Error {
  constructor() {
    super("You do not have permission to access this overtime request.");
    this.name = "OvertimeRequestAccessError";
  }
}

export class OvertimeEmployeeNotFoundError extends Error {
  constructor() {
    super("No Employee record is linked to this account.");
    this.name = "OvertimeEmployeeNotFoundError";
  }
}

export class OvertimeApproverNotFoundError extends Error {
  constructor(stage: "Supervisor" | "Manager") {
    super(`An active assigned ${stage} is required for this overtime workflow.`);
    this.name = "OvertimeApproverNotFoundError";
  }
}

export class OvertimeRequestNotFoundError extends Error {
  constructor() {
    super("Overtime request not found.");
    this.name = "OvertimeRequestNotFoundError";
  }
}

export class OvertimeApprovalScopeError extends Error {
  constructor() {
    super("This overtime request is not assigned to you for review.");
    this.name = "OvertimeApprovalScopeError";
  }
}

export class OvertimeApprovalStageError extends Error {
  constructor() {
    super("This overtime request is no longer awaiting your review.");
    this.name = "OvertimeApprovalStageError";
  }
}

export class OvertimeRequestTimeError extends Error {
  constructor() {
    super("Enter valid start and end times in your configured timezone; the end time must be later than the start time.");
    this.name = "OvertimeRequestTimeError";
  }
}

function assertEmployee(actor: OvertimeActor): asserts actor is Exclude<OvertimeActor, null> {
  if (
    !actor
    || actor.role !== "EMPLOYEE"
    || !hasPermission(actor.role, "overtime:submit")
  ) {
    throw new OvertimeRequestAccessError();
  }
}

function assertApprover(actor: OvertimeActor): asserts actor is Exclude<OvertimeActor, null> {
  if (
    !actor
    || (actor.role !== "SUPERVISOR" && actor.role !== "DEPARTMENT_MANAGER")
    || !hasPermission(actor.role, "overtime:approve")
  ) {
    throw new OvertimeRequestAccessError();
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
    throw new OvertimeRequestTimeError();
  }
  return { startAt, endAt };
}

const ownRequestSelect = {
  id: true,
  date: true,
  startAt: true,
  endAt: true,
  reason: true,
  project: true,
  expectedHours: true,
  status: true,
  currentApprovalStage: true,
  decisionReason: true,
  createdAt: true,
  reviewedAt: true,
} satisfies Prisma.OvertimeRequestSelect;

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
} satisfies Prisma.OvertimeRequestSelect;

export async function submitOwnOvertimeRequest(
  actor: OvertimeActor,
  input: unknown,
  database: OvertimeRequestDatabase = prisma,
) {
  assertEmployee(actor);
  const parsed = overtimeRequestInputSchema.parse(input);
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
    if (!employee?.userId) throw new OvertimeEmployeeNotFoundError();
    const supervisor = employee.supervisor;
    if (
      !supervisor?.userId
      || supervisor.user?.role !== "SUPERVISOR"
      || !supervisor.user.isActive
    ) {
      throw new OvertimeApproverNotFoundError("Supervisor");
    }
    const manager = employee.manager;
    if (
      !manager?.userId
      || manager.user?.role !== "DEPARTMENT_MANAGER"
      || !manager.user.isActive
    ) {
      throw new OvertimeApproverNotFoundError("Manager");
    }

    const request = await transaction.overtimeRequest.create({
      data: {
        employeeId: employee.id,
        date: new Date(`${parsed.date}T00:00:00.000Z`),
        startAt,
        endAt,
        reason: parsed.reason,
        project: parsed.project,
        expectedHours: parsed.expectedHours,
        status: OvertimeRequestStatus.PENDING,
        currentApprovalStage: OvertimeApprovalStage.SUPERVISOR,
        currentApproverId: supervisor.userId,
      },
      select: ownRequestSelect,
    });
    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: actor.id,
        actorId: actor.id,
        actionType: "OVERTIME_REQUEST_SUBMITTED",
        newValues: {
          overtimeRequestId: request.id,
          date: parsed.date,
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          project: parsed.project,
          expectedHours: parsed.expectedHours.toString(),
          status: OvertimeRequestStatus.PENDING,
          currentApprovalStage: OvertimeApprovalStage.SUPERVISOR,
        },
        reason: parsed.reason,
      },
      select: { id: true },
    });
    await transaction.notification.create({
      data: {
        userId: supervisor.userId,
        title: "Overtime request pending",
        message: `An overtime request for ${parsed.date} is awaiting your review.`,
        type: "OVERTIME_REQUEST_PENDING",
      },
      select: { id: true },
    });
    return request;
  });
}

export async function listOwnOvertimeRequests(
  actor: OvertimeActor,
  database: Pick<PrismaClient, "employee" | "overtimeRequest"> = prisma,
) {
  assertEmployee(actor);
  const employee = await database.employee.findUnique({
    where: { userId: actor.id },
    select: { id: true },
  });
  if (!employee) throw new OvertimeEmployeeNotFoundError();
  return database.overtimeRequest.findMany({
    where: { employeeId: employee.id },
    select: ownRequestSelect,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
}

export async function listOvertimeRequestsForReview(
  actor: OvertimeActor,
  database: Pick<PrismaClient, "employee" | "overtimeRequest"> = prisma,
) {
  assertApprover(actor);
  const managerDepartmentId = actor.role === "DEPARTMENT_MANAGER"
    ? await getActiveManagerDepartmentId(database, actor.id)
    : null;
  if (actor.role === "DEPARTMENT_MANAGER" && !managerDepartmentId) return [];
  const stage = actor.role === "SUPERVISOR"
    ? OvertimeApprovalStage.SUPERVISOR
    : OvertimeApprovalStage.MANAGER;
  return database.overtimeRequest.findMany({
    where: {
      status: OvertimeRequestStatus.PENDING,
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

export async function decideOvertimeRequest(
  actor: OvertimeActor,
  overtimeRequestId: string,
  input: unknown,
  database: OvertimeApprovalDatabase = prisma,
) {
  assertApprover(actor);
  const decision = overtimeDecisionSchema.parse(input);
  const stage = actor.role === "SUPERVISOR"
    ? OvertimeApprovalStage.SUPERVISOR
    : OvertimeApprovalStage.MANAGER;

  return database.$transaction(async (transaction) => {
    const managerDepartmentId = actor.role === "DEPARTMENT_MANAGER"
      ? await lockActiveManagerDepartmentId(transaction, actor.id)
      : null;
    if (actor.role === "DEPARTMENT_MANAGER" && !managerDepartmentId) throw new OvertimeApprovalScopeError();
    const requestReference = await transaction.overtimeRequest.findUnique({
      where: { id: overtimeRequestId },
      select: { employeeId: true },
    });
    if (!requestReference) throw new OvertimeRequestNotFoundError();
    await lockEmployeeForApproval(transaction, requestReference.employeeId);
    const request = await transaction.overtimeRequest.findUnique({
      where: { id: overtimeRequestId },
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
    if (!request) throw new OvertimeRequestNotFoundError();
    if (request.employee.userId === actor.id) throw new OvertimeApprovalScopeError();
    if (
      request.status !== OvertimeRequestStatus.PENDING
      || request.currentApprovalStage !== stage
      || request.currentApproverId !== actor.id
    ) {
      throw new OvertimeApprovalStageError();
    }
    const assigned = actor.role === "SUPERVISOR"
      ? request.employee.supervisor?.userId === actor.id
        && request.employee.supervisor.user?.role === "SUPERVISOR"
        && request.employee.supervisor.user.isActive
      : request.employee.manager?.userId === actor.id
        && request.employee.manager.user?.role === "DEPARTMENT_MANAGER"
        && request.employee.manager.user.isActive
        && request.employee.departmentId === managerDepartmentId;
    if (!assigned) throw new OvertimeApprovalScopeError();
    if (actor.role === "SUPERVISOR" && decision.action === "APPROVE" && (
      !request.employee.manager?.userId
      || request.employee.manager.user?.role !== "DEPARTMENT_MANAGER"
      || !request.employee.manager.user.isActive
    )) {
      throw new OvertimeApproverNotFoundError("Manager");
    }

    const nextStage = actor.role === "SUPERVISOR" && decision.action === "APPROVE"
      ? OvertimeApprovalStage.MANAGER
      : null;
    const status = decision.action === "REJECT" ? OvertimeRequestStatus.REJECTED
      : nextStage ? OvertimeRequestStatus.PENDING : OvertimeRequestStatus.APPROVED;
    const currentApproverId = nextStage ? request.employee.manager!.userId : null;
    const reviewedAt = new Date();
    const updated = await transaction.overtimeRequest.updateMany({
      where: {
        id: request.id,
        status: OvertimeRequestStatus.PENDING,
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
    if (updated.count !== 1) throw new OvertimeApprovalStageError();

    const actionType = decision.action === "REJECT"
      ? "OVERTIME_REQUEST_REJECTED"
      : nextStage ? "OVERTIME_REQUEST_SUPERVISOR_APPROVED" : "OVERTIME_REQUEST_APPROVED";
    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: request.employee.userId,
        actorId: actor.id,
        actionType,
        previousValues: {
          overtimeRequestId: request.id,
          status: request.status,
          currentApprovalStage: request.currentApprovalStage,
          currentApproverId: request.currentApproverId,
        },
        newValues: {
          overtimeRequestId: request.id,
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
          title: "Overtime request pending",
          message: `An overtime request for ${request.date.toISOString().slice(0, 10)} is awaiting your review.`,
          type: "OVERTIME_REQUEST_PENDING",
        },
        select: { id: true },
      });
    } else if (request.employee.userId) {
      const outcome = status === OvertimeRequestStatus.APPROVED ? "approved" : "rejected";
      await transaction.notification.create({
        data: {
          userId: request.employee.userId,
          title: `Overtime request ${outcome}`,
          message: `Your overtime request for ${request.date.toISOString().slice(0, 10)} was ${outcome}.`,
          type: status === OvertimeRequestStatus.APPROVED ? "OVERTIME_REQUEST_APPROVED" : "OVERTIME_REQUEST_REJECTED",
        },
        select: { id: true },
      });
    }
    return { id: request.id, status, currentApprovalStage: nextStage, reviewedById: actor.id, reviewedAt };
  });
}
