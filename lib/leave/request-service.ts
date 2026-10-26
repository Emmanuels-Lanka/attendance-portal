import "server-only";

import { LeaveRequestStatus, type Prisma, type PrismaClient, type Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/auth/permissions";
import { leaveRequestInputSchema, leaveRequestListQuerySchema } from "@/lib/leave/validation";
import {
  getHalfDayIntervals,
  getTimeLeaveInterval,
  LeaveScheduleConfigurationError,
  type LeaveShiftSchedule,
} from "@/lib/leave/periods";
import { resolveShiftForDate, type EffectiveShiftAssignment } from "@/lib/attendance/shift-assignment";

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

export class LeaveRequestOverlapError extends Error {
  constructor() {
    super("An active Leave request already overlaps these dates.");
    this.name = "LeaveRequestOverlapError";
  }
}

export class LeaveRequestScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaveRequestScheduleError";
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
      user: { select: { timeZone: true, countryCode: true } },
      shift: {
        select: {
          id: true,
          startTime: true,
          endTime: true,
          gracePeriodMinutes: true,
          breakStartTime: true,
          breakDurationMinutes: true,
          workingDays: true,
        },
      },
      shiftAssignments: {
        select: {
          effectiveFrom: true,
          effectiveTo: true,
          shift: {
            select: {
              id: true,
              startTime: true,
              endTime: true,
              gracePeriodMinutes: true,
              breakStartTime: true,
              breakDurationMinutes: true,
              workingDays: true,
            },
          },
        },
      },
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
  startTime: true,
  endTime: true,
  halfDayPeriod: true,
  status: true,
  currentApprovalStage: true,
  currentApproverId: true,
  decisionReason: true,
  reviewedById: true,
  reviewedAt: true,
  cancellationStatus: true,
  cancellationReason: true,
  cancellationRequestedAt: true,
  cancellationApprovalStage: true,
  cancellationReviewedAt: true,
  cancellationDecisionReason: true,
  createdAt: true,
  updatedAt: true,
  leaveType: { select: { id: true, name: true } },
} satisfies Prisma.LeaveRequestSelect;

function databaseTime(value: string | null) {
  return value ? new Date(`1970-01-01T${value}:00.000Z`) : null;
}

function resolveShift(employee: Awaited<ReturnType<typeof getOwnEmployee>>, date: string) {
  const assignments = employee.shiftAssignments?.length
    ? employee.shiftAssignments
    : employee.shift
      ? [{
          effectiveFrom: new Date("0001-01-01T00:00:00.000Z"),
          effectiveTo: null,
          shift: employee.shift,
        }]
      : [];
  const resolution = resolveShiftForDate(
    assignments as EffectiveShiftAssignment<LeaveShiftSchedule & { id: string }>[],
    date,
  );
  if (resolution.kind !== "ASSIGNED") {
    throw new LeaveRequestScheduleError("A configured effective shift with this date as a working day is required for partial leave.");
  }
  return resolution.shift;
}

export async function submitOwnLeaveRequest(
  actor: LeaveRequestActor | null,
  input: unknown,
  database: LeaveRequestDatabase = prisma,
) {
  assertPermission(actor, "leave:submit");
  const parsed = leaveRequestInputSchema.parse(input);

  return database.$transaction(async (transaction) => {
    const employee = await getOwnEmployee(actor, transaction);
    await transaction.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${employee.id} FOR UPDATE`;
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
      select: { id: true, durationMode: true },
    });
    if (!leaveType) throw new LeaveRequestLeaveTypeNotFoundError();
    const durationMode = leaveType.durationMode ?? "FULL_DAY";
    let shift: LeaveShiftSchedule | null = null;
    if (durationMode === "FULL_DAY") {
      if (parsed.startTime || parsed.endTime || parsed.halfDayPeriod) {
        throw new LeaveRequestScheduleError("Full-day leave uses a date range and cannot include partial-day times.");
      }
    } else {
      if (parsed.startDate !== parsed.endDate) {
        throw new LeaveRequestScheduleError("Partial leave must be requested for one employee-local date.");
      }
      if (!employee.user?.timeZone) {
        throw new LeaveRequestScheduleError("The employee's timezone is required to validate partial leave.");
      }
      shift = resolveShift(employee, parsed.startDate);
      try {
        if (durationMode === "HALF_DAY") {
          if (!parsed.halfDayPeriod || parsed.startTime || parsed.endTime) {
            throw new LeaveRequestScheduleError("Select a morning or afternoon half-day period.");
          }
          getHalfDayIntervals(parsed.startDate, employee.user.timeZone, shift, parsed.halfDayPeriod);
        } else {
          if (!parsed.startTime || !parsed.endTime || parsed.halfDayPeriod) {
            throw new LeaveRequestScheduleError("Short leave requires a start time and an end time.");
          }
          getTimeLeaveInterval(parsed.startDate, employee.user.timeZone, shift, parsed.startTime, parsed.endTime);
        }
      } catch (error) {
        if (error instanceof LeaveScheduleConfigurationError) throw new LeaveRequestScheduleError(error.message);
        throw error;
      }
    }

    if (parsed.attachmentDocumentId) {
      const attachment = await transaction.employeeDocument.findFirst({
        where: { id: parsed.attachmentDocumentId, employeeId: employee.id },
        select: { id: true },
      });
      if (!attachment) throw new LeaveRequestAttachmentNotFoundError();
    }

    const overlap = await transaction.leaveRequest.findFirst({
      where: {
        employeeId: employee.id,
        status: { in: [LeaveRequestStatus.PENDING, LeaveRequestStatus.APPROVED] },
        startDate: { lte: asDatabaseDate(parsed.endDate) },
        endDate: { gte: asDatabaseDate(parsed.startDate) },
      },
      select: { id: true },
    });
    if (overlap) throw new LeaveRequestOverlapError();

    const request = await transaction.leaveRequest.create({
      data: {
        employeeId: employee.id,
        leaveTypeId: parsed.leaveTypeId,
        startDate: asDatabaseDate(parsed.startDate),
        endDate: asDatabaseDate(parsed.endDate),
        startTime: databaseTime(parsed.startTime),
        endTime: databaseTime(parsed.endTime),
        halfDayPeriod: parsed.halfDayPeriod,
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
