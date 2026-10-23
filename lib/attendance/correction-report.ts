import "server-only";

import { AttendanceCorrectionStatus, type Prisma, type PrismaClient, type Role } from "@prisma/client";
import { z } from "zod";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";

const reportStatuses = ["ALL", ...Object.values(AttendanceCorrectionStatus)] as const;
const pageSize = 25;

const calendarDate = z.string().refine((value) => {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Use a valid calendar date.");

export const attendanceCorrectionReportFiltersSchema = z.object({
  status: z.enum(reportStatuses).default("ALL"),
  employeeId: z.string().trim().max(100).default(""),
  from: calendarDate.default(""),
  to: calendarDate.default(""),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
}).refine(({ from, to }) => !from || !to || from <= to, {
  message: "The start date must be on or before the end date.",
  path: ["to"],
});

type ReportActor = { role: Role } | null;
type ReportDatabase = Pick<PrismaClient, "attendanceCorrectionRequest" | "user">;

export class AttendanceCorrectionReportAuthorizationError extends Error {
  constructor() {
    super("Attendance report access is required.");
    this.name = "AttendanceCorrectionReportAuthorizationError";
  }
}

function assertReportAccess(actor: ReportActor): asserts actor is Exclude<ReportActor, null> {
  if (!actor || !hasPermission(actor.role, "reports:read")) {
    throw new AttendanceCorrectionReportAuthorizationError();
  }
}

function utcDate(value: string) {
  return value ? new Date(`${value}T00:00:00.000Z`) : undefined;
}

function nextUtcDate(value: string) {
  if (!value) return undefined;
  const date = utcDate(value)!;
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

const correctionReportSelect = {
  id: true,
  status: true,
  currentApprovalStage: true,
  originalValues: true,
  requestedValues: true,
  reason: true,
  decisionNote: true,
  resolutionReason: true,
  requestedAt: true,
  reviewedAt: true,
  resolvedAt: true,
  sessionId: true,
  originalMode: true,
  requestedMode: true,
  originalStartAt: true,
  originalEndAt: true,
  session: { select: { startAt: true } },
  employee: { select: { id: true, name: true, employeeCode: true } },
  requester: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
} satisfies Prisma.AttendanceCorrectionRequestSelect;

export async function listAttendanceCorrectionReport(
  actor: ReportActor,
  input: unknown,
  database: ReportDatabase = prisma,
) {
  assertReportAccess(actor);
  const filters = attendanceCorrectionReportFiltersSchema.parse(input);
  const from = utcDate(filters.from);
  const toExclusive = nextUtcDate(filters.to);
  const where: Prisma.AttendanceCorrectionRequestWhereInput = {
    ...(filters.status !== "ALL" ? { status: filters.status } : {}),
    ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
    ...((from || toExclusive) ? {
      requestedAt: {
        ...(from ? { gte: from } : {}),
        ...(toExclusive ? { lt: toExclusive } : {}),
      },
    } : {}),
  };

  const total = await database.attendanceCorrectionRequest.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(filters.page, pageCount);
  const [entries, employees] = await Promise.all([
    database.attendanceCorrectionRequest.findMany({
      where,
      select: correctionReportSelect,
      orderBy: [{ requestedAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    database.user.findMany({
      where: { correctionRequests: { some: {} } },
      select: { id: true, name: true, employeeCode: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  ]);

  return {
    entries,
    employees,
    total,
    page,
    pageCount,
    filters: { ...filters, page },
  };
}
