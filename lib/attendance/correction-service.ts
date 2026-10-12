import "server-only";

import {
  AttendanceCorrectionApprovalStage,
  AttendanceCorrectionStatus,
  type Prisma,
  type PrismaClient,
  type Role,
} from "@prisma/client";
import { z } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import {
  applyApprovedAttendanceCorrection,
  AttendanceCorrectionEngineConflictError,
} from "@/lib/attendance/engine-service";

type AttendanceCorrectionActor = { id: string; role: Role } | null;
type AttendanceCorrectionDatabase = Pick<PrismaClient, "$transaction">;
type OwnCorrectionDailyAttendance = {
  id: string;
  date: Date;
  firstIn: Date | null;
  lastOut: Date | null;
  status: string | null;
};
type OwnCorrectionAttendanceReadDatabase = {
  attendanceDaily: {
    findMany: (args: {
      where: Prisma.AttendanceDailyWhereInput;
      select: { id: true; date: true; firstIn: true; lastOut: true; status: true };
      orderBy: Array<{ date: "desc" } | { id: "desc" }>;
    }) => Promise<OwnCorrectionDailyAttendance[]>;
  };
};

const dailyCorrectionValuesSchema = z.object({
  firstIn: z.string().datetime({ offset: true }).nullable().optional(),
  lastOut: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().refine((values) => Object.keys(values).length > 0, "Provide at least one supported attendance time.");

export const dailyAttendanceCorrectionInputSchema = z.object({
  requestedValues: dailyCorrectionValuesSchema,
  reason: z.string().trim().min(1, "A correction reason is required.").max(500),
});

export const dailyAttendanceCorrectionDecisionSchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  reason: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().trim().max(500).optional(),
  ),
});

export class DailyAttendanceCorrectionAccessError extends Error {
  constructor() {
    super("You do not have permission to request this attendance correction.");
    this.name = "DailyAttendanceCorrectionAccessError";
  }
}

export class DailyAttendanceCorrectionReviewerScopeError extends Error {
  constructor() {
    super("This correction is not assigned to you for review.");
    this.name = "DailyAttendanceCorrectionReviewerScopeError";
  }
}

export class DailyAttendanceCorrectionStageError extends Error {
  constructor() {
    super("This correction is not awaiting your review or has already been finalized.");
    this.name = "DailyAttendanceCorrectionStageError";
  }
}

export class DailyAttendanceCorrectionConflictError extends Error {
  constructor() {
    super("The calculated attendance changed after this correction was requested. Review the current values before deciding.");
    this.name = "DailyAttendanceCorrectionConflictError";
  }
}

export class DailyAttendanceCorrectionReviewerNotFoundError extends Error {
  constructor() {
    super("A correction reviewer must have an active User account.");
    this.name = "DailyAttendanceCorrectionReviewerNotFoundError";
  }
}

export class DailyAttendanceCorrectionRequesterNotFoundError extends Error {
  constructor() {
    super("The requesting User was not found.");
    this.name = "DailyAttendanceCorrectionRequesterNotFoundError";
  }
}

export class DailyAttendanceCorrectionTargetNotFoundError extends Error {
  constructor() {
    super("The calculated daily attendance record was not found.");
    this.name = "DailyAttendanceCorrectionTargetNotFoundError";
  }
}

export class DailyAttendanceCorrectionSubjectUserNotFoundError extends Error {
  constructor() {
    super("The Employee for this attendance record is not linked to a User account.");
    this.name = "DailyAttendanceCorrectionSubjectUserNotFoundError";
  }
}

export async function listOwnDailyAttendanceForCorrection(
  actor: AttendanceCorrectionActor,
  database: OwnCorrectionAttendanceReadDatabase = prisma,
) {
  if (
    !actor
    || actor.role !== "EMPLOYEE"
    || !hasPermission(actor.role, "attendance:correction:submit")
  ) {
    throw new DailyAttendanceCorrectionAccessError();
  }

  return database.attendanceDaily.findMany({
    where: {
      employee: {
        userId: actor.id,
        supervisor: { user: { role: "SUPERVISOR", isActive: true } },
      },
    },
    select: {
      id: true,
      date: true,
      firstIn: true,
      lastOut: true,
      status: true,
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
  });
}

function originalAttendanceSnapshot(
  attendance: {
    employeeId: string;
    date: Date;
    shiftId: string | null;
    firstIn: Date | null;
    lastOut: Date | null;
    workingHours: Prisma.Decimal | null;
    lateMinutes: number | null;
    earlyMinutes: number | null;
    status: string | null;
    overtimeHours: Prisma.Decimal | null;
  },
): Prisma.InputJsonObject {
  return {
    employeeId: attendance.employeeId,
    date: attendance.date.toISOString(),
    shiftId: attendance.shiftId,
    firstIn: attendance.firstIn?.toISOString() ?? null,
    lastOut: attendance.lastOut?.toISOString() ?? null,
    workingHours: attendance.workingHours?.toString() ?? null,
    lateMinutes: attendance.lateMinutes,
    earlyMinutes: attendance.earlyMinutes,
    status: attendance.status,
    overtimeHours: attendance.overtimeHours?.toString() ?? null,
  };
}

export async function submitDailyAttendanceCorrection(
  actor: AttendanceCorrectionActor,
  dailyAttendanceId: string,
  input: unknown,
  database: AttendanceCorrectionDatabase = prisma,
) {
  if (!actor || !hasPermission(actor.role, "attendance:correction:submit")) {
    throw new DailyAttendanceCorrectionAccessError();
  }
  const parsed = dailyAttendanceCorrectionInputSchema.parse(input);

  return database.$transaction(async (transaction) => {
    const requester = await transaction.user.findUnique({
      where: { id: actor.id },
      select: { id: true, role: true },
    });
    if (!requester) throw new DailyAttendanceCorrectionRequesterNotFoundError();
    if (requester.role !== actor.role || (actor.role !== "EMPLOYEE" && actor.role !== "SUPERVISOR")) {
      throw new DailyAttendanceCorrectionAccessError();
    }

    const attendance = await transaction.attendanceDaily.findUnique({
      where: { id: dailyAttendanceId },
      select: {
        id: true,
        employeeId: true,
        date: true,
        shiftId: true,
        firstIn: true,
        lastOut: true,
        workingHours: true,
        lateMinutes: true,
        earlyMinutes: true,
        status: true,
        overtimeHours: true,
        employee: {
          select: {
            id: true,
            userId: true,
            supervisor: {
              select: {
                userId: true,
                user: { select: { role: true, isActive: true } },
              },
            },
          },
        },
      },
    });
    if (!attendance) throw new DailyAttendanceCorrectionTargetNotFoundError();
    if (!attendance.employee.userId) throw new DailyAttendanceCorrectionSubjectUserNotFoundError();
    if (actor.role === "EMPLOYEE" && attendance.employee.userId !== actor.id) {
      throw new DailyAttendanceCorrectionAccessError();
    }
    if (
      !attendance.employee.supervisor?.userId
      || attendance.employee.supervisor.user?.role !== "SUPERVISOR"
      || !attendance.employee.supervisor.user.isActive
    ) {
      throw new DailyAttendanceCorrectionReviewerNotFoundError();
    }
    if (actor.role === "SUPERVISOR" && attendance.employee.supervisor.userId !== actor.id) {
      throw new DailyAttendanceCorrectionReviewerScopeError();
    }

    const originalValues = originalAttendanceSnapshot(attendance);
    const correctionRequest = await transaction.attendanceCorrectionRequest.create({
      data: {
        employeeId: attendance.employee.userId,
        dailyAttendanceId: attendance.id,
        requesterId: requester.id,
        reason: parsed.reason,
        status: AttendanceCorrectionStatus.PENDING,
        currentApprovalStage: actor.role === "SUPERVISOR"
          ? AttendanceCorrectionApprovalStage.HR
          : AttendanceCorrectionApprovalStage.SUPERVISOR,
        originalValues,
        requestedValues: parsed.requestedValues as Prisma.InputJsonObject,
      },
    });

    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: attendance.employee.userId,
        actorId: requester.id,
        correctionRequestId: correctionRequest.id,
        actionType: "ATTENDANCE_CORRECTION_REQUESTED",
        previousValues: originalValues,
        newValues: parsed.requestedValues,
        reason: parsed.reason,
      },
      select: { id: true },
    });

    return correctionRequest;
  });
}

const correctionReviewSelect = {
  id: true,
  employeeId: true,
  requesterId: true,
  reason: true,
  status: true,
  currentApprovalStage: true,
  originalValues: true,
  requestedValues: true,
  requestedAt: true,
  dailyAttendance: {
    select: {
      id: true,
      employeeId: true,
      date: true,
      firstIn: true,
      lastOut: true,
      status: true,
      employee: {
        select: {
          id: true,
          name: true,
          employeeId: true,
          supervisor: { select: { userId: true } },
        },
      },
    },
  },
  employee: { select: { id: true, name: true, employeeCode: true } },
} satisfies Prisma.AttendanceCorrectionRequestSelect;

function assertCorrectionReviewer(actor: AttendanceCorrectionActor): asserts actor is Exclude<AttendanceCorrectionActor, null> {
  if (
    !actor
    || !hasPermission(actor.role, "attendance:correction:approve")
    || (actor.role !== "SUPERVISOR" && actor.role !== "HR_ADMINISTRATOR")
  ) {
    throw new DailyAttendanceCorrectionAccessError();
  }
}

export async function listDailyAttendanceCorrections(
  actor: AttendanceCorrectionActor,
  database: Pick<PrismaClient, "attendanceCorrectionRequest"> = prisma,
) {
  assertCorrectionReviewer(actor);
  const stage = actor.role === "SUPERVISOR"
    ? AttendanceCorrectionApprovalStage.SUPERVISOR
    : AttendanceCorrectionApprovalStage.HR;
  const where: Prisma.AttendanceCorrectionRequestWhereInput = {
    status: AttendanceCorrectionStatus.PENDING,
    currentApprovalStage: stage,
    ...(actor.role === "SUPERVISOR"
      ? { dailyAttendance: { employee: { supervisor: { userId: actor.id } } } }
      : {}),
  };
  return database.attendanceCorrectionRequest.findMany({
    where,
    select: correctionReviewSelect,
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
  });
}

export async function decideDailyAttendanceCorrection(
  actor: AttendanceCorrectionActor,
  correctionRequestId: string,
  input: unknown,
  database: AttendanceCorrectionDatabase = prisma,
) {
  assertCorrectionReviewer(actor);
  const decision = dailyAttendanceCorrectionDecisionSchema.parse(input);

  return database.$transaction(async (transaction) => {
    const correction = await transaction.attendanceCorrectionRequest.findUnique({
      where: { id: correctionRequestId },
      select: {
        id: true,
        employeeId: true,
        requesterId: true,
        reason: true,
        status: true,
        currentApprovalStage: true,
        originalValues: true,
        requestedValues: true,
        dailyAttendanceId: true,
        dailyAttendance: {
          select: {
            id: true,
            employeeId: true,
            date: true,
            firstIn: true,
            lastOut: true,
            employee: {
              select: {
                id: true,
                userId: true,
                supervisor: { select: { userId: true } },
              },
            },
          },
        },
      },
    });
    if (!correction) throw new DailyAttendanceCorrectionTargetNotFoundError();
    if (
      correction.status !== AttendanceCorrectionStatus.PENDING
      || (correction.currentApprovalStage !== AttendanceCorrectionApprovalStage.SUPERVISOR
        && correction.currentApprovalStage !== AttendanceCorrectionApprovalStage.HR)
    ) {
      throw new DailyAttendanceCorrectionStageError();
    }

    const expectedRole = correction.currentApprovalStage === AttendanceCorrectionApprovalStage.SUPERVISOR
      ? "SUPERVISOR"
      : "HR_ADMINISTRATOR";
    if (actor.role !== expectedRole) throw new DailyAttendanceCorrectionAccessError();
    if (
      correction.currentApprovalStage === AttendanceCorrectionApprovalStage.SUPERVISOR
      && correction.dailyAttendance?.employee.supervisor?.userId !== actor.id
    ) {
      throw new DailyAttendanceCorrectionReviewerScopeError();
    }

    if (!correction.dailyAttendance || !correction.dailyAttendanceId) {
      throw new DailyAttendanceCorrectionTargetNotFoundError();
    }
    if (correction.dailyAttendance.employee.userId !== correction.employeeId) {
      throw new DailyAttendanceCorrectionConflictError();
    }
    const requestedResult = dailyCorrectionValuesSchema.safeParse(correction.requestedValues);
    if (!requestedResult.success) throw new DailyAttendanceCorrectionConflictError();

    const requested = requestedResult.data;
    const currentValues = {
      firstIn: correction.dailyAttendance.firstIn?.toISOString() ?? null,
      lastOut: correction.dailyAttendance.lastOut?.toISOString() ?? null,
    };
    const original = correction.originalValues;
    if (!original || typeof original !== "object" || Array.isArray(original)) {
      throw new DailyAttendanceCorrectionConflictError();
    }
    if (original.firstIn !== currentValues.firstIn || original.lastOut !== currentValues.lastOut) {
      throw new DailyAttendanceCorrectionConflictError();
    }

    const nextStage = decision.action === "APPROVE"
      && correction.currentApprovalStage === AttendanceCorrectionApprovalStage.SUPERVISOR
      ? AttendanceCorrectionApprovalStage.HR
      : null;
    const finalApproval = decision.action === "APPROVE" && nextStage === null;
    const status = decision.action === "REJECT"
      ? AttendanceCorrectionStatus.REJECTED
      : finalApproval ? AttendanceCorrectionStatus.APPROVED : AttendanceCorrectionStatus.PENDING;
    const now = new Date();
    const decisionReason = decision.reason ?? null;
    const auditReason = decision.reason ?? correction.reason;
    const correctionValues = finalApproval
      ? {
          ...(requested.firstIn !== undefined ? { firstIn: requested.firstIn === null ? null : new Date(requested.firstIn) } : {}),
          ...(requested.lastOut !== undefined ? { lastOut: requested.lastOut === null ? null : new Date(requested.lastOut) } : {}),
        }
      : {};
    let finalizedValues: Prisma.InputJsonObject | undefined;

    const changed = await transaction.attendanceCorrectionRequest.updateMany({
      where: {
        id: correction.id,
        status: AttendanceCorrectionStatus.PENDING,
        currentApprovalStage: correction.currentApprovalStage,
        ...(correction.currentApprovalStage === AttendanceCorrectionApprovalStage.SUPERVISOR
          ? { dailyAttendance: { employee: { supervisor: { userId: actor.id } } } }
          : {}),
      },
      data: {
        status,
        currentApprovalStage: nextStage,
        reviewedById: actor.id,
        reviewedAt: now,
        ...(finalApproval || decision.action === "REJECT" ? { resolvedAt: now } : {}),
        ...(decisionReason !== null ? { decisionNote: decisionReason } : {}),
        ...(decision.action === "REJECT" ? { resolutionReason: decisionReason } : {}),
      },
    });
    if (changed.count !== 1) throw new DailyAttendanceCorrectionStageError();

    if (finalApproval) {
      try {
        const calculation = await applyApprovedAttendanceCorrection(transaction, {
          dailyAttendanceId: correction.dailyAttendanceId,
          employeeId: correction.dailyAttendance.employee.id,
          date: correction.dailyAttendance.date.toISOString().slice(0, 10),
          expectedFirstIn: correction.dailyAttendance.firstIn,
          expectedLastOut: correction.dailyAttendance.lastOut,
          correction: correctionValues,
        });
        finalizedValues = {
          firstIn: calculation.firstIn?.toISOString() ?? null,
          lastOut: calculation.lastOut?.toISOString() ?? null,
          workingHours: calculation.workingHours,
          lateMinutes: calculation.lateMinutes,
          earlyMinutes: calculation.earlyMinutes,
          status: calculation.status,
        };
      } catch (error) {
        if (error instanceof AttendanceCorrectionEngineConflictError) {
          throw new DailyAttendanceCorrectionConflictError();
        }
        throw error;
      }
    }

    const actionType = decision.action === "REJECT"
      ? "ATTENDANCE_CORRECTION_REJECTED"
      : correction.currentApprovalStage === AttendanceCorrectionApprovalStage.SUPERVISOR
        ? "ATTENDANCE_CORRECTION_SUPERVISOR_APPROVED"
        : "ATTENDANCE_CORRECTION_HR_APPROVED";
    const auditNewValues: Prisma.InputJsonObject = {
      status,
      currentApprovalStage: nextStage,
      ...(finalizedValues ? { attendance: finalizedValues } : {}),
    };
    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: correction.employeeId,
        actorId: actor.id,
        correctionRequestId: correction.id,
        actionType,
        previousValues: {
          status: correction.status,
          currentApprovalStage: correction.currentApprovalStage,
          attendance: correction.originalValues,
        },
        newValues: auditNewValues,
        reason: auditReason,
      },
      select: { id: true },
    });

    if (finalApproval) {
      await transaction.notification.create({
        data: {
          userId: correction.employeeId,
          title: "Attendance correction approved",
          message: "Your attendance correction was approved.",
          type: "ATTENDANCE_CORRECTION_APPROVED",
        },
        select: { id: true },
      });
    }

    return { id: correction.id, status, currentApprovalStage: nextStage };
  });
}
