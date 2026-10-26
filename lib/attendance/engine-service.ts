import "server-only";

import type { DailyAttendanceMode, Prisma, PrismaClient, WorkMode } from "@prisma/client";
import { fromZonedTime } from "date-fns-tz";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  attendanceDailyWorkingHoursForStorage,
  calculateDailyAttendance,
  AttendanceEngineConfigurationError,
  type DailyAttendanceCorrectionValues,
} from "./engine";
import { getEmployeeLocalDayWindow } from "./timezone";
import { getEmployeeLocalMonthWindow } from "./timezone";
import { monthlyGraceAllowancesUsedBeforeEachDate } from "./history";
import { isOptionalSriLankanSaturday, resolveShiftForDate } from "./shift-assignment";

export type EngineDatabase = Pick<PrismaClient, "$transaction">;

export class AttendanceEngineEmployeeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendanceEngineEmployeeError";
  }
}

export class AttendanceDailyPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendanceDailyPersistenceError";
  }
}

export class AttendanceCorrectionEngineConflictError extends Error {
  constructor() {
    super("Calculated attendance changed or the approved correction cannot be represented safely by the attendance engine.");
    this.name = "AttendanceCorrectionEngineConflictError";
  }
}

const shiftConfigurationSelect = {
  id: true,
  startTime: true,
  endTime: true,
  gracePeriodMinutes: true,
  lateThresholdMinutes: true,
  earlyDepartureThresholdMinutes: true,
  breakDurationMinutes: true,
  minimumWorkingHours: true,
  overtimeEligible: true,
  roundingRules: true,
  workingDays: true,
} satisfies Prisma.ShiftSelect;

type EngineTransaction = Prisma.TransactionClient;

const approvedCorrectionValuesSchema = z.object({
  firstIn: z.string().datetime({ offset: true }).nullable().optional(),
  lastOut: z.string().datetime({ offset: true }).nullable().optional(),
  requestedMode: z.enum(["OFFICE", "WFH"]).optional(),
}).strict();

type ApprovedCorrectionValues = DailyAttendanceCorrectionValues & {
  fallbackMode?: WorkMode | null;
  fallbackModes?: Set<WorkMode>;
};

async function loadApprovedCorrectionValues(
  transaction: EngineTransaction,
  dailyAttendanceId: string,
): Promise<ApprovedCorrectionValues> {
  const requests = await transaction.attendanceCorrectionRequest.findMany({
    where: { dailyAttendanceId, status: "APPROVED" },
    select: { requestedValues: true },
    orderBy: [{ resolvedAt: "asc" }, { requestedAt: "asc" }, { id: "asc" }],
  });

  const correction: ApprovedCorrectionValues = {
    fallbackMode: null,
    fallbackModes: new Set(),
  };
  for (const request of requests) {
    const result = approvedCorrectionValuesSchema.safeParse(request.requestedValues);
    if (!result.success) {
      throw new AttendanceDailyPersistenceError("An approved attendance correction contains invalid values.");
    }
    if (result.data.firstIn !== undefined) {
      correction.firstIn = result.data.firstIn === null ? null : new Date(result.data.firstIn);
    }
    if (result.data.lastOut !== undefined) {
      correction.lastOut = result.data.lastOut === null ? null : new Date(result.data.lastOut);
    }
    if (result.data.requestedMode !== undefined) {
      correction.fallbackModes?.add(result.data.requestedMode);
      correction.fallbackMode = result.data.requestedMode;
    }
  }
  return correction;
}

async function calculateForEmployeeDay(
  transaction: EngineTransaction,
  employeeId: string,
  date: string,
  correction?: ApprovedCorrectionValues,
) {
  const employee = await transaction.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      userId: true,
      user: { select: { timeZone: true, countryCode: true } },
      shift: { select: shiftConfigurationSelect },
      shiftAssignments: {
        select: {
          effectiveFrom: true,
          effectiveTo: true,
          shift: { select: shiftConfigurationSelect },
        },
      },
    },
  });
  if (!employee) throw new AttendanceEngineEmployeeError("Employee was not found.");
  if (!employee.user) throw new AttendanceEngineEmployeeError("Employee has no linked user timezone.");
  const employeeShiftAssignments = employee.shiftAssignments ?? [];
  const assignments = employeeShiftAssignments.length > 0
    ? employeeShiftAssignments
    : employee.shift
      ? [{
          effectiveFrom: new Date("0001-01-01T00:00:00.000Z"),
          effectiveTo: null,
          shift: employee.shift,
        }]
      : [];
  const resolution = resolveShiftForDate(assignments, date);
  const optionalSaturday = isOptionalSriLankanSaturday(employee.user.countryCode, date);
  const optionalSaturdayWithoutAssignment = optionalSaturday && resolution.kind === "NON_WORKING_DAY";
  const selectedShift = resolution.kind === "ASSIGNED"
    || resolution.kind === "NON_WORKING_DAY"
    || resolution.kind === "UNCONFIGURED_WORKING_DAYS"
    ? resolution.shift
    : null;
  const applicableShift = optionalSaturdayWithoutAssignment ? null : selectedShift;

  const { startAt, endAt } = getEmployeeLocalDayWindow(
    fromZonedTime(`${date}T12:00:00.000`, employee.user.timeZone),
    employee.user.timeZone,
  );
  const monthWindow = getEmployeeLocalMonthWindow(date, employee.user.timeZone);
  const punches = await transaction.attendanceRaw.findMany({
    where: { employeeId, timestamp: { gte: startAt, lt: endAt } },
    orderBy: [{ timestamp: "asc" }, { id: "asc" }],
    select: { id: true, timestamp: true, punchType: true, workMode: true },
  });
  const sessions = employee.userId
    ? await transaction.workSession.findMany({
        where: {
          record: { employeeId: employee.userId },
          OR: [
            { startAt: { gte: startAt, lt: endAt } },
            { endAt: { gte: startAt, lt: endAt } },
          ],
        },
        select: { id: true, mode: true, startAt: true, endAt: true },
        orderBy: [{ startAt: "asc" }, { id: "asc" }],
      })
    : [];
    const monthSessions = employee.userId
      ? await transaction.workSession.findMany({
          where: {
            record: { employeeId: employee.userId },
            startAt: { gte: monthWindow.startAt, lt: endAt },
          },
          select: { id: true, mode: true, startAt: true, endAt: true },
          orderBy: [{ startAt: "asc" }, { id: "asc" }],
        })
      : [];
  // Sessions hold correction-aware values; raw punches remain immutable calculation evidence.
  if (optionalSaturday && resolution.kind === "NON_WORKING_DAY" && punches.length > 0) {
    throw new AttendanceEngineConfigurationError(
      "Saturday punches exist but no Saturday-applicable Shift is assigned for this employee-local date.",
    );
  }
  if (!applicableShift && !optionalSaturdayWithoutAssignment) {
    const message = resolution.kind === "AMBIGUOUS"
      ? "Multiple configured shifts apply to this employee and date."
      : resolution.kind === "UNCONFIGURED_WORKING_DAYS"
        ? "Configure working weekdays for the assigned Shift before calculating attendance."
        : "Assign a configured Shift that applies to this employee-local date before calculating attendance.";
    throw new AttendanceEngineConfigurationError(message);
  }
  const dateValue = new Date(`${date}T00:00:00.000Z`);
  const holiday = "holiday" in transaction
    ? await transaction.holiday.findFirst({
        where: { date: dateValue, branch: "", applicableEmployeeGroups: { isEmpty: true } },
        select: { id: true },
      })
    : null;
  const modes = new Set<WorkMode>();
  for (const session of sessions) {
    modes.add(session.mode);
  }
  if (sessions.length === 0) {
    if ((correction?.fallbackModes?.size ?? 0) > 1) {
      throw new AttendanceDailyPersistenceError(
        "Approved work-mode corrections conflict because no effective session is available.",
      );
    }
    for (const punch of punches) {
      if (punch.workMode) modes.add(punch.workMode);
    }
    if (correction?.fallbackMode) {
      modes.clear();
      modes.add(correction.fallbackMode);
    }
  }
  const mode: DailyAttendanceMode | null = modes.size > 1
    ? "MIXED"
    : modes.values().next().value ?? null;
  const monthlyGraceAllowancesUsed = monthlyGraceAllowancesUsedBeforeEachDate(
    monthSessions,
    employee.user.timeZone,
    assignments,
  ).get(date);
  const sessionStarts = sessions
    .map(({ startAt }) => startAt)
    .filter((value) => value >= startAt && value < endAt)
    .sort((left, right) => left.getTime() - right.getTime());
  const sessionEnds = sessions
    .map(({ endAt: value }) => value)
    .filter((value): value is Date => Boolean(value && value >= startAt && value < endAt))
    .sort((left, right) => left.getTime() - right.getTime());
  const effectiveCorrection: DailyAttendanceCorrectionValues = {
    ...(correction?.firstIn !== undefined ? { firstIn: correction.firstIn } : {}),
    ...(correction?.lastOut !== undefined ? { lastOut: correction.lastOut } : {}),
    ...(sessionStarts.length > 0 ? { firstIn: sessionStarts[0] } : {}),
    ...(sessionStarts.length > 0 && sessionEnds.length === 0 ? { lastOut: null } : {}),
    ...(sessionEnds.length > 0 ? { lastOut: sessionEnds.at(-1)! } : {}),
  };
  const calculation = calculateDailyAttendance({
    employeeId,
    date,
    timeZone: employee.user.timeZone,
    mode,
    shift: applicableShift
      ? {
          ...applicableShift,
          minimumWorkingHours: applicableShift.minimumWorkingHours?.toString() ?? null,
        }
      : null,
    punches,
    monthlyGraceAllowancesUsed,
    correction: Object.keys(effectiveCorrection).length > 0 ? effectiveCorrection : undefined,
    holiday: holiday !== null,
    optionalWorkday: optionalSaturday,
  });

  return {
    calculation,
    dateValue,
    data: {
      employeeId,
      date: dateValue,
      mode: calculation.mode,
      shiftId: calculation.shiftId,
      firstIn: calculation.firstIn,
      lastOut: calculation.lastOut,
      workingHours: attendanceDailyWorkingHoursForStorage(calculation.workingHours),
      lateMinutes: calculation.lateMinutes,
      earlyMinutes: calculation.earlyMinutes,
      status: calculation.status,
    },
  };
}

export async function calculateAndPersistDailyAttendanceInTransaction(
  transaction: EngineTransaction,
  employeeId: string,
  date: string,
) {
  await transaction.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${employeeId} FOR UPDATE`;
  const dateValue = new Date(`${date}T00:00:00.000Z`);
  const existing = await transaction.attendanceDaily.findMany({
    where: { employeeId, date: dateValue },
    select: { id: true },
    take: 2,
  });
  if (existing.length > 1) {
    throw new AttendanceDailyPersistenceError("Multiple daily attendance rows exist for this employee and date.");
  }

  const approvedCorrection = existing[0]
    ? await loadApprovedCorrectionValues(transaction, existing[0].id)
    : undefined;
  const calculated = await calculateForEmployeeDay(transaction, employeeId, date, approvedCorrection);
  const attendanceDaily = existing[0]
    ? await transaction.attendanceDaily.update({ where: { id: existing[0].id }, data: calculated.data })
    : await transaction.attendanceDaily.create({ data: calculated.data });

  return { calculation: calculated.calculation, attendanceDaily };
}

export async function recalculateAttendanceMonthsFromDatesInTransaction(
  transaction: EngineTransaction,
  input: {
    employeeRecordId: string;
    employeeUserId: string;
    timeZone: string;
    affectedDates: readonly string[];
    excludeDates?: readonly string[];
  },
) {
  const earliestDateByMonth = new Map<string, string>();
  for (const date of input.affectedDates) {
    const month = date.slice(0, 7);
    const current = earliestDateByMonth.get(month);
    if (!current || date < current) earliestDateByMonth.set(month, date);
  }

  const recalculated: Array<{
    date: string;
    result: Awaited<ReturnType<typeof calculateAndPersistDailyAttendanceInTransaction>>;
  }> = [];
  const excludedDates = new Set(input.excludeDates ?? []);
  for (const [month, fromDate] of [...earliestDateByMonth].sort(([left], [right]) => left.localeCompare(right))) {
    const monthStartDate = `${month}-01`;
    const nextMonth = new Date(`${monthStartDate}T00:00:00.000Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const nextMonthDate = nextMonth.toISOString().slice(0, 10);
    const monthWindow = getEmployeeLocalMonthWindow(fromDate, input.timeZone);
    const [dailyRows, rawPunches, sessions] = await Promise.all([
      transaction.attendanceDaily.findMany({
        where: {
          employeeId: input.employeeRecordId,
          date: {
            gte: new Date(`${monthStartDate}T00:00:00.000Z`),
            lt: new Date(`${nextMonthDate}T00:00:00.000Z`),
          },
        },
        select: { date: true },
      }),
      transaction.attendanceRaw.findMany({
        where: {
          employeeId: input.employeeRecordId,
          timestamp: { gte: monthWindow.startAt, lt: monthWindow.endAt },
        },
        select: { timestamp: true },
      }),
      transaction.workSession.findMany({
        where: {
          record: { employeeId: input.employeeUserId },
          OR: [
            { startAt: { gte: monthWindow.startAt, lt: monthWindow.endAt } },
            { endAt: { gte: monthWindow.startAt, lt: monthWindow.endAt } },
          ],
        },
        select: { startAt: true, endAt: true },
      }),
    ]);

    const dates = new Set<string>([fromDate]);
    for (const row of dailyRows) {
      const date = row.date.toISOString().slice(0, 10);
      if (date >= fromDate) dates.add(date);
    }
    for (const punch of rawPunches) {
      const date = getEmployeeLocalDayWindow(punch.timestamp, input.timeZone).date;
      if (date >= fromDate) dates.add(date);
    }
    for (const session of sessions) {
      for (const endpoint of [session.startAt, session.endAt]) {
        if (!endpoint) continue;
        const date = getEmployeeLocalDayWindow(endpoint, input.timeZone).date;
        if (date >= fromDate) dates.add(date);
      }
    }

    for (const date of [...dates].sort()) {
      if (excludedDates.has(date)) continue;
      recalculated.push({
        date,
        result: await calculateAndPersistDailyAttendanceInTransaction(
          transaction,
          input.employeeRecordId,
          date,
        ),
      });
    }
  }
  return recalculated;
}

export async function calculateAndPersistDailyAttendance(
  employeeId: string,
  date: string,
  database: EngineDatabase = prisma,
) {
  return database.$transaction((transaction) =>
    calculateAndPersistDailyAttendanceInTransaction(transaction, employeeId, date),
  );
}

export async function applyApprovedAttendanceCorrection(
  transaction: EngineTransaction,
  input: {
    dailyAttendanceId: string | null;
    employeeId: string;
    date: string;
    expectedFirstIn: Date | null;
    expectedLastOut: Date | null;
    correction: DailyAttendanceCorrectionValues;
  },
) {
  await transaction.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${input.employeeId} FOR UPDATE`;
  const dateValue = new Date(`${input.date}T00:00:00.000Z`);
  const current = input.dailyAttendanceId
    ? await transaction.attendanceDaily.findUnique({
        where: { id: input.dailyAttendanceId },
        select: { id: true, employeeId: true, date: true, firstIn: true, lastOut: true },
      })
    : null;
  if (
    (input.dailyAttendanceId !== null && !current)
    || (current !== null && (
      current.employeeId !== input.employeeId
      || current.date.toISOString().slice(0, 10) !== input.date
      || current.firstIn?.getTime() !== input.expectedFirstIn?.getTime()
      || current.lastOut?.getTime() !== input.expectedLastOut?.getTime()
    ))
  ) {
    throw new AttendanceCorrectionEngineConflictError();
  }

  const existingRows = input.dailyAttendanceId === null
    ? await transaction.attendanceDaily.findMany({
        where: { employeeId: input.employeeId, date: dateValue },
        select: { id: true },
        take: 2,
      })
    : [];
  if (existingRows.length > 0) throw new AttendanceCorrectionEngineConflictError();

  const approvedCorrection = current
    ? await loadApprovedCorrectionValues(transaction, current.id)
    : {};
  const calculated = await calculateForEmployeeDay(
    transaction,
    input.employeeId,
    input.date,
    { ...approvedCorrection, ...input.correction },
  );
  if (
    (input.correction.firstIn !== undefined
      && calculated.calculation.firstIn?.getTime() !== input.correction.firstIn?.getTime())
    || (input.correction.lastOut !== undefined
      && calculated.calculation.lastOut?.getTime() !== input.correction.lastOut?.getTime())
  ) {
    throw new AttendanceCorrectionEngineConflictError();
  }

  const attendanceDaily = current
    ? await transaction.attendanceDaily.updateMany({
        where: {
          id: current.id,
          employeeId: input.employeeId,
          firstIn: current.firstIn,
          lastOut: current.lastOut,
        },
        data: calculated.data,
      }).then(async (updated) => {
        if (updated.count !== 1) throw new AttendanceCorrectionEngineConflictError();
        return transaction.attendanceDaily.findUnique({
          where: { id: current.id },
          select: { id: true },
        });
      })
    : await transaction.attendanceDaily.create({ data: calculated.data, select: { id: true } });
  if (!attendanceDaily) throw new AttendanceCorrectionEngineConflictError();
  return { calculation: calculated.calculation, attendanceDaily };
}
