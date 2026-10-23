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
type OwnCorrectionHistoryDatabase = Pick<PrismaClient, "attendanceCorrectionRequest">;
type OwnCorrectionSessionReadDatabase = Pick<PrismaClient, "workSession">;

const dailyCorrectionValuesSchema = z.object({
  firstIn: z.string().datetime({ offset: true }).nullable().optional(),
  lastOut: z.string().datetime({ offset: true }).nullable().optional(),
}).strict().refine((values) => Object.keys(values).length > 0, "Provide at least one supported attendance time.");

export const dailyAttendanceCorrectionInputSchema = z.object({
  requestedValues: dailyCorrectionValuesSchema,
  reason: z.string().trim().min(1, "A correction reason is required.").max(500),
});

export const attendanceSessionModeCorrectionInputSchema = z.object({
  requestedMode: z.enum(["OFFICE", "WFH"]),
  reason: z.string().trim().min(1, "A correction reason is required.").max(500),
}).strict();

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

export class DailyAttendanceCorrectionPendingRequestExistsError extends Error {
  constructor() {
    super("A pending correction request already exists for this attendance date.");
    this.name = "DailyAttendanceCorrectionPendingRequestExistsError";
  }
}

export class DailyAttendanceCorrectionSelfApprovalError extends Error {
  constructor() {
    super("You cannot approve an attendance correction for your own account.");
    this.name = "DailyAttendanceCorrectionSelfApprovalError";
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

export async function listOwnAttendanceCorrectionHistory(
  actor: AttendanceCorrectionActor,
  database: OwnCorrectionHistoryDatabase = prisma,
) {
  if (
    !actor
    || actor.role !== "EMPLOYEE"
    || !hasPermission(actor.role, "attendance:correction:submit")
  ) {
    throw new DailyAttendanceCorrectionAccessError();
  }

  return database.attendanceCorrectionRequest.findMany({
    where: { employeeId: actor.id },
    select: {
      id: true,
      dailyAttendanceId: true,
      status: true,
      reason: true,
      requestedValues: true,
      decisionNote: true,
      resolutionReason: true,
      requestedAt: true,
      reviewedAt: true,
      resolvedAt: true,
      sessionId: true,
      originalMode: true,
      requestedMode: true,
      reviewedBy: { select: { name: true } },
      dailyAttendance: { select: { date: true } },
      session: { select: { startAt: true } },
    },
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
  });
}

export async function listOwnAttendanceSessionsForCorrection(
  actor: AttendanceCorrectionActor,
  database: OwnCorrectionSessionReadDatabase = prisma,
) {
  if (
    !actor
    || actor.role !== "EMPLOYEE"
    || !hasPermission(actor.role, "attendance:correction:submit")
  ) {
    throw new DailyAttendanceCorrectionAccessError();
  }

  return database.workSession.findMany({
    where: {
      record: {
        employeeId: actor.id,
        employee: {
          employee: {
            supervisor: { user: { role: "SUPERVISOR", isActive: true } },
          },
        },
      },
    },
    select: { id: true, mode: true, startAt: true, endAt: true },
    orderBy: [{ startAt: "desc" }, { id: "desc" }],
    take: 100,
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

async function notifyActiveHrReviewers(
  transaction: Prisma.TransactionClient,
  date: Date,
) {
  const reviewers = await transaction.user.findMany({
    where: { role: "HR_ADMINISTRATOR", isActive: true },
    select: { id: true },
  });
  for (const reviewer of reviewers) {
    await transaction.notification.create({
      data: {
        userId: reviewer.id,
        title: "Attendance correction pending",
        message: `An attendance correction for ${date.toISOString().slice(0, 10)} is awaiting your review.`,
        type: "ATTENDANCE_CORRECTION_PENDING",
      },
      select: { id: true },
    });
  }
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

    const initialAttendance = await transaction.attendanceDaily.findUnique({
      where: { id: dailyAttendanceId },
      select: {
        id: true,
        employeeId: true,
      },
    });
    if (!initialAttendance) throw new DailyAttendanceCorrectionTargetNotFoundError();

    await transaction.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${initialAttendance.employeeId} FOR UPDATE`;

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

    const pendingRequest = await transaction.attendanceCorrectionRequest.findFirst({
      where: {
        dailyAttendanceId: attendance.id,
        status: AttendanceCorrectionStatus.PENDING,
      },
      select: { id: true },
    });
    if (pendingRequest) throw new DailyAttendanceCorrectionPendingRequestExistsError();

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

    if (actor.role === "EMPLOYEE") {
      await transaction.notification.create({
        data: {
          userId: attendance.employee.supervisor.userId,
          title: "Attendance correction pending",
          message: `An attendance correction for ${attendance.date.toISOString().slice(0, 10)} is awaiting your review.`,
          type: "ATTENDANCE_CORRECTION_PENDING",
        },
        select: { id: true },
      });
    } else {
      await notifyActiveHrReviewers(transaction, attendance.date);
    }

    return correctionRequest;
  });
}

export async function submitAttendanceSessionModeCorrection(
  actor: AttendanceCorrectionActor,
  sessionId: string,
  input: unknown,
  database: AttendanceCorrectionDatabase = prisma,
) {
  if (
    !actor
    || actor.role !== "EMPLOYEE"
    || !hasPermission(actor.role, "attendance:correction:submit")
  ) {
    throw new DailyAttendanceCorrectionAccessError();
  }
  const parsed = attendanceSessionModeCorrectionInputSchema.parse(input);

  return database.$transaction(async (transaction) => {
    const requester = await transaction.user.findUnique({
      where: { id: actor.id },
      select: { id: true, role: true, isActive: true },
    });
    if (!requester || !requester.isActive) throw new DailyAttendanceCorrectionRequesterNotFoundError();
    if (requester.role !== actor.role) throw new DailyAttendanceCorrectionAccessError();

    await transaction.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.id} FOR UPDATE`;
    const session = await transaction.workSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        mode: true,
        startAt: true,
        endAt: true,
        record: {
          select: {
            employeeId: true,
            employee: {
              select: {
                employee: {
                  select: {
                    id: true,
                    supervisor: {
                      select: {
                        userId: true,
                        user: { select: { role: true, isActive: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!session) throw new DailyAttendanceCorrectionTargetNotFoundError();
    if (session.record.employeeId !== actor.id) throw new DailyAttendanceCorrectionAccessError();
    const employee = session.record.employee.employee;
    if (
      !employee?.supervisor?.userId
      || employee.supervisor.user?.role !== "SUPERVISOR"
      || !employee.supervisor.user.isActive
    ) {
      throw new DailyAttendanceCorrectionReviewerNotFoundError();
    }
    if (parsed.requestedMode === session.mode) {
      throw new z.ZodError([{
        code: "custom",
        path: ["requestedMode"],
        message: "Choose the other work mode; the session already has that mode.",
      }]);
    }

    const pendingRequest = await transaction.attendanceCorrectionRequest.findFirst({
      where: { sessionId: session.id, status: AttendanceCorrectionStatus.PENDING },
      select: { id: true },
    });
    if (pendingRequest) throw new DailyAttendanceCorrectionPendingRequestExistsError();

    const originalValues: Prisma.InputJsonObject = {
      sessionId: session.id,
      mode: session.mode,
      startAt: session.startAt.toISOString(),
      endAt: session.endAt?.toISOString() ?? null,
    };
    const requestedValues: Prisma.InputJsonObject = { requestedMode: parsed.requestedMode };
    const correctionRequest = await transaction.attendanceCorrectionRequest.create({
      data: {
        employeeId: actor.id,
        requesterId: requester.id,
        sessionId: session.id,
        reason: parsed.reason,
        status: AttendanceCorrectionStatus.PENDING,
        currentApprovalStage: AttendanceCorrectionApprovalStage.SUPERVISOR,
        originalMode: session.mode,
        requestedMode: parsed.requestedMode,
        originalStartAt: session.startAt,
        originalEndAt: session.endAt,
        originalValues,
        requestedValues,
      },
    });
    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: actor.id,
        sessionId: session.id,
        actorId: requester.id,
        correctionRequestId: correctionRequest.id,
        actionType: "ATTENDANCE_CORRECTION_REQUESTED",
        previousValues: originalValues,
        newValues: requestedValues,
        reason: parsed.reason,
      },
      select: { id: true },
    });
    await transaction.notification.create({
      data: {
        userId: employee.supervisor.userId,
        title: "Attendance correction pending",
        message: `A work-mode correction for ${session.startAt.toISOString().slice(0, 10)} is awaiting your review.`,
        type: "ATTENDANCE_CORRECTION_PENDING",
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
  sessionId: true,
  originalMode: true,
  requestedMode: true,
  originalStartAt: true,
  originalEndAt: true,
  session: {
    select: {
      id: true,
      mode: true,
      startAt: true,
      endAt: true,
      record: {
        select: {
          employee: { select: { id: true, name: true, employeeCode: true } },
        },
      },
    },
  },
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
      ? {
          OR: [
            { dailyAttendance: { employee: { supervisor: { userId: actor.id } } } },
            {
              session: {
                record: {
                  employee: {
                    employee: { supervisor: { userId: actor.id } },
                  },
                },
              },
            },
          ],
        }
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
        sessionId: true,
        originalMode: true,
        requestedMode: true,
        originalStartAt: true,
        originalEndAt: true,
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
        session: {
          select: {
            id: true,
            mode: true,
            startAt: true,
            endAt: true,
            record: {
              select: {
                employeeId: true,
                employee: {
                  select: {
                    employee: {
                      select: {
                        supervisor: { select: { userId: true } },
                      },
                    },
                  },
                },
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
    const isSessionModeCorrection = Boolean(correction.sessionId);
    if (
      correction.currentApprovalStage === AttendanceCorrectionApprovalStage.SUPERVISOR
      && (isSessionModeCorrection
        ? correction.session?.record.employee.employee?.supervisor?.userId !== actor.id
        : correction.dailyAttendance?.employee.supervisor?.userId !== actor.id)
    ) {
      throw new DailyAttendanceCorrectionReviewerScopeError();
    }

    if (correction.employeeId === actor.id) {
      throw new DailyAttendanceCorrectionSelfApprovalError();
    }
    if (isSessionModeCorrection) {
      if (
        !correction.session
        || correction.session.id !== correction.sessionId
        || correction.session.record.employeeId !== correction.employeeId
        || correction.originalMode !== correction.session.mode
        || correction.requestedMode === null
        || correction.requestedMode === correction.originalMode
        || correction.originalStartAt?.getTime() !== correction.session.startAt.getTime()
      ) {
        throw new DailyAttendanceCorrectionConflictError();
      }
    } else if (!correction.dailyAttendance || !correction.dailyAttendanceId) {
      throw new DailyAttendanceCorrectionTargetNotFoundError();
    }
    if (isSessionModeCorrection && !correction.originalValues) {
      throw new DailyAttendanceCorrectionConflictError();
    }
    if (!isSessionModeCorrection && correction.dailyAttendance?.employee.userId !== correction.employeeId) {
      throw new DailyAttendanceCorrectionConflictError();
    }
    let requested: z.infer<typeof dailyCorrectionValuesSchema> = {};
    if (isSessionModeCorrection) {
      const modeRequest = attendanceSessionModeCorrectionInputSchema
        .pick({ requestedMode: true })
        .safeParse(correction.requestedValues);
      if (!modeRequest.success || modeRequest.data.requestedMode !== correction.requestedMode) {
        throw new DailyAttendanceCorrectionConflictError();
      }
    } else {
      const requestedResult = dailyCorrectionValuesSchema.safeParse(correction.requestedValues);
      if (!requestedResult.success) throw new DailyAttendanceCorrectionConflictError();
      const attendance = correction.dailyAttendance!;
      const currentValues = {
        firstIn: attendance.firstIn?.toISOString() ?? null,
        lastOut: attendance.lastOut?.toISOString() ?? null,
      };
      const original = correction.originalValues;
      if (!original || typeof original !== "object" || Array.isArray(original)) {
        throw new DailyAttendanceCorrectionConflictError();
      }
      if (original.firstIn !== currentValues.firstIn || original.lastOut !== currentValues.lastOut) {
        throw new DailyAttendanceCorrectionConflictError();
      }
      requested = requestedResult.data;
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
    const correctionValues = finalApproval && !isSessionModeCorrection
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
          ? isSessionModeCorrection
            ? { session: { record: { employee: { employee: { supervisor: { userId: actor.id } } } } } }
            : { dailyAttendance: { employee: { supervisor: { userId: actor.id } } } }
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
      if (isSessionModeCorrection) {
        await transaction.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${correction.employeeId} FOR UPDATE`;
        const updated = await transaction.workSession.updateMany({
          where: {
            id: correction.sessionId!,
            mode: correction.originalMode!,
            startAt: correction.originalStartAt!,
          },
          data: { mode: correction.requestedMode! },
        });
        if (updated.count !== 1) throw new DailyAttendanceCorrectionConflictError();
        const finalizedSession = await transaction.workSession.findUnique({
          where: { id: correction.sessionId! },
          select: { id: true, mode: true, startAt: true, endAt: true },
        });
        if (!finalizedSession || finalizedSession.mode !== correction.requestedMode) {
          throw new DailyAttendanceCorrectionConflictError();
        }
        finalizedValues = {
          sessionId: finalizedSession.id,
          mode: finalizedSession.mode,
          startAt: finalizedSession.startAt.toISOString(),
          endAt: finalizedSession.endAt?.toISOString() ?? null,
        };
      } else {
        const attendance = correction.dailyAttendance;
        if (!attendance || !correction.dailyAttendanceId) {
          throw new DailyAttendanceCorrectionTargetNotFoundError();
        }
        try {
        const calculation = await applyApprovedAttendanceCorrection(transaction, {
          dailyAttendanceId: correction.dailyAttendanceId,
          employeeId: attendance.employee.id,
          date: attendance.date.toISOString().slice(0, 10),
          expectedFirstIn: attendance.firstIn,
          expectedLastOut: attendance.lastOut,
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
    }

    const actionType = decision.action === "REJECT"
      ? "ATTENDANCE_CORRECTION_REJECTED"
      : correction.currentApprovalStage === AttendanceCorrectionApprovalStage.SUPERVISOR
        ? "ATTENDANCE_CORRECTION_SUPERVISOR_APPROVED"
        : "ATTENDANCE_CORRECTION_HR_APPROVED";
    const auditNewValues: Prisma.InputJsonObject = {
      status,
      currentApprovalStage: nextStage,
      ...(finalizedValues
        ? isSessionModeCorrection ? { session: finalizedValues } : { attendance: finalizedValues }
        : {}),
    };
    await transaction.attendanceAuditLog.create({
      data: {
        employeeId: correction.employeeId,
        ...(isSessionModeCorrection ? { sessionId: correction.sessionId } : {}),
        actorId: actor.id,
        correctionRequestId: correction.id,
        actionType,
        previousValues: {
          status: correction.status,
          currentApprovalStage: correction.currentApprovalStage,
          ...(isSessionModeCorrection
            ? { session: correction.originalValues }
            : { attendance: correction.originalValues }),
        },
        newValues: auditNewValues,
        reason: auditReason,
      },
      select: { id: true },
    });

    if (nextStage === AttendanceCorrectionApprovalStage.HR) {
      const correctionDate = correction.dailyAttendance?.date ?? correction.session?.startAt;
      if (!correctionDate) throw new DailyAttendanceCorrectionTargetNotFoundError();
      await notifyActiveHrReviewers(transaction, correctionDate);
    } else {
      const outcome = status === AttendanceCorrectionStatus.APPROVED ? "approved" : "rejected";
      await transaction.notification.create({
        data: {
          userId: correction.employeeId,
          title: `Attendance correction ${outcome}`,
          message: `Your attendance correction was ${outcome}.`,
          type: status === AttendanceCorrectionStatus.APPROVED
            ? "ATTENDANCE_CORRECTION_APPROVED"
            : "ATTENDANCE_CORRECTION_REJECTED",
        },
        select: { id: true },
      });
    }

    return { id: correction.id, status, currentApprovalStage: nextStage };
  });
}
