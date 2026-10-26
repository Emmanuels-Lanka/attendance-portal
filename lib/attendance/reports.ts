import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { hasPermission } from "@/lib/auth/permissions";
import { AttendanceEngineConfigurationError, calculateDailyAttendance, type AttendanceEngineShift } from "@/lib/attendance/engine";
import { monthlyGraceAllowancesUsedBeforeEachDate } from "@/lib/attendance/history";
import { prisma } from "@/lib/prisma";
import type { Prisma, PrismaClient, Role } from "@prisma/client";
import { isOptionalSriLankanSaturday, resolveShiftForDate, type EffectiveShiftAssignment } from "./shift-assignment";

export type MonthlySession = {
  id: string;
  mode: "OFFICE" | "WFH";
  startAt: Date;
  endAt: Date | null;
};

export type MonthlyDaySummary = {
  date: string;
  sessions: MonthlySession[];
  totalWorkedMs: number;
  approvedWorkFromHome?: boolean;
};

export type MonthlyEmployeeReport = {
  monthLabel: string;
  empty: boolean;
  summary: {
    totalSessions: number;
    completedSessions: number;
    activeSessions: number;
    totalWorkedMs: number;
    workFromHomeDays?: number;
    engineWorkedMs?: number | null;
    engineCalculatedDays?: number;
    totalWorkingDays?: number | null;
    presentDays?: number | null;
    absentDays?: number | null;
    lateDays?: number | null;
    earlyOutDays?: number | null;
    missingPunchDays?: number | null;
    weekendDays?: number | null;
    holidayDays?: number | null;
    unmatchedScopedHolidayDates?: number;
    approvedLeaveDays?: number | null;
    undeterminedDays?: number | null;
    totalCalculatedDays?: number;
    pendingExpectedOvertimeHours?: number;
    pendingOvertimeRequestCount?: number;
    approvedExpectedOvertimeHours?: number;
    approvedOvertimeRequestCount?: number;
    rejectedExpectedOvertimeHours?: number;
    rejectedOvertimeRequestCount?: number;
    recordedActualOvertimeHours?: number | null;
    recordedActualOvertimeEmployees?: number;
    recordedActualOvertimeDays?: number;
    conflictingActualOvertimeDays?: number;
  };
  days: MonthlyDaySummary[];
};

export type MonthlyDailyStatus = {
  date: string;
  status?: "PRESENT" | "LATE" | "EARLY_OUT" | "MISSING_PUNCH" | "WEEKEND" | "HOLIDAY" | "ABSENT" | "UNDETERMINED" | string | null;
  workingHours?: number | null;
  lateMinutes?: number | null;
  earlyMinutes?: number | null;
};

export type MonthlyOvertimeSummary = {
  pendingExpectedHours: number;
  pendingRequestCount: number;
  approvedExpectedHours: number;
  approvedRequestCount: number;
  rejectedExpectedHours: number;
  rejectedRequestCount: number;
  recordedActualHours: number | null;
  recordedActualEmployees: number;
  recordedActualDays: number;
  conflictingActualDays: number;
};

type MonthlyOvertimeRequestInput = { date: string; status: string; expectedHours: number | string };
type MonthlyActualOvertimeInput = { date: string; overtimeHours: number | string | null };

export function buildMonthlyOvertimeSummary(
  month: string,
  requests: MonthlyOvertimeRequestInput[],
  dailyRows: MonthlyActualOvertimeInput[],
): MonthlyOvertimeSummary {
  buildMonthWindow(month, "UTC");
  const expectedHundredths = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
  const requestCounts = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
  for (const request of requests) {
    if (request.date.slice(0, 7) !== month || !(request.status in expectedHundredths)) continue;
    const amount = Number(request.expectedHours);
    if (!Number.isFinite(amount) || amount < 0) continue;
    const status = request.status as keyof typeof expectedHundredths;
    expectedHundredths[status] += Math.round(amount * 100);
    requestCounts[status] += 1;
  }

  const actualByDate = new Map<string, number | null>();
  const conflictingDates = new Set<string>();
  for (const row of dailyRows) {
    if (row.date.slice(0, 7) !== month) continue;
    const amount = row.overtimeHours === null ? null : Number(row.overtimeHours);
    const value = amount !== null && Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
    if (!actualByDate.has(row.date)) actualByDate.set(row.date, value);
    else if (actualByDate.get(row.date) !== value) {
      actualByDate.set(row.date, null);
      conflictingDates.add(row.date);
    }
  }

  const actualValues = [...actualByDate.entries()].filter(([, value]) => value !== null);
  const actualTotalHundredths = actualValues.reduce((total, [, value]) => total + (value ?? 0), 0);
  return {
    pendingExpectedHours: expectedHundredths.PENDING / 100,
    pendingRequestCount: requestCounts.PENDING,
    approvedExpectedHours: expectedHundredths.APPROVED / 100,
    approvedRequestCount: requestCounts.APPROVED,
    rejectedExpectedHours: expectedHundredths.REJECTED / 100,
    rejectedRequestCount: requestCounts.REJECTED,
    recordedActualHours: actualValues.length > 0 ? actualTotalHundredths / 100 : null,
    recordedActualEmployees: actualValues.length > 0 ? 1 : 0,
    recordedActualDays: actualValues.length,
    conflictingActualDays: conflictingDates.size,
  };
}

export function aggregateMonthlyOvertimeSummaries(summaries: Partial<MonthlyOvertimeSummary>[]): MonthlyOvertimeSummary {
  const summariesWithActual = summaries.filter((summary) => summary.recordedActualHours !== null && summary.recordedActualHours !== undefined);
  return {
    pendingExpectedHours: summaries.reduce((total, summary) => total + (summary.pendingExpectedHours ?? 0), 0),
    pendingRequestCount: summaries.reduce((total, summary) => total + (summary.pendingRequestCount ?? 0), 0),
    approvedExpectedHours: summaries.reduce((total, summary) => total + (summary.approvedExpectedHours ?? 0), 0),
    approvedRequestCount: summaries.reduce((total, summary) => total + (summary.approvedRequestCount ?? 0), 0),
    rejectedExpectedHours: summaries.reduce((total, summary) => total + (summary.rejectedExpectedHours ?? 0), 0),
    rejectedRequestCount: summaries.reduce((total, summary) => total + (summary.rejectedRequestCount ?? 0), 0),
    recordedActualHours: summariesWithActual.length > 0
      ? summariesWithActual.reduce((total, summary) => total + (summary.recordedActualHours ?? 0), 0)
      : null,
        recordedActualEmployees: summaries.reduce((total, summary) => total + (summary.recordedActualEmployees ?? (summary.recordedActualHours != null ? 1 : 0)), 0),
    recordedActualDays: summaries.reduce((total, summary) => total + (summary.recordedActualDays ?? 0), 0),
    conflictingActualDays: summaries.reduce((total, summary) => total + (summary.conflictingActualDays ?? 0), 0),
  };
}

type EmployeeMonthlyReportDatabase = Pick<PrismaClient, "employee" | "workSession" | "attendanceDaily" | "attendanceRaw" | "holiday" | "leaveRequest" | "overtimeRequest" | "workFromHomeRequest">;

function summarizeCalculatedDailyStatuses(dailySummaries: MonthlyDailyStatus[]) {
  type CalculatedStatus = "PRESENT" | "LATE" | "EARLY_OUT" | "MISSING_PUNCH" | "WEEKEND" | "HOLIDAY" | "ABSENT" | "UNDETERMINED";
  const statuses = new Set<CalculatedStatus>([
    "PRESENT",
    "LATE",
    "EARLY_OUT",
    "MISSING_PUNCH",
    "WEEKEND",
    "HOLIDAY",
    "ABSENT",
    "UNDETERMINED",
  ]);
  const counts = {
    PRESENT: 0,
    LATE: 0,
    EARLY_OUT: 0,
    MISSING_PUNCH: 0,
    WEEKEND: 0,
    HOLIDAY: 0,
    ABSENT: 0,
    UNDETERMINED: 0,
  } satisfies Record<CalculatedStatus, number>;
  const statusByDate = new Map<string, CalculatedStatus>();

  for (const item of dailySummaries) {
    if (!item.status || !statuses.has(item.status as CalculatedStatus)) continue;
    const status = item.status as CalculatedStatus;
    const previous = statusByDate.get(item.date);
    statusByDate.set(item.date, previous && previous !== status ? "UNDETERMINED" : status);
  }

  for (const status of statusByDate.values()) counts[status] += 1;

  return {
    presentDays: statusByDate.size > 0 ? counts.PRESENT : null,
    absentDays: statusByDate.size > 0 ? counts.ABSENT : null,
    lateDays: statusByDate.size > 0 ? counts.LATE : null,
    earlyOutDays: statusByDate.size > 0 ? counts.EARLY_OUT : null,
    missingPunchDays: statusByDate.size > 0 ? counts.MISSING_PUNCH : null,
    weekendDays: statusByDate.size > 0 ? counts.WEEKEND : null,
    holidayDays: counts.HOLIDAY,
    undeterminedDays: statusByDate.size > 0 ? counts.UNDETERMINED : null,
    totalCalculatedDays: statusByDate.size,
  };
}

function summarizeEngineWorkedTime(dailySummaries: MonthlyDailyStatus[]) {
  const hoursByDate = new Map<string, number | null>();
  for (const item of dailySummaries) {
    const hours = item.workingHours;
    const value = hours !== null && hours !== undefined && Number.isFinite(hours) && hours >= 0 ? hours : null;
    if (!hoursByDate.has(item.date)) {
      hoursByDate.set(item.date, value);
    } else if (hoursByDate.get(item.date) !== value) {
      hoursByDate.set(item.date, null);
    }
  }

  let engineWorkedMs = 0;
  let engineCalculatedDays = 0;
  for (const hours of hoursByDate.values()) {
    if (hours === null) continue;
    engineWorkedMs += Math.round(hours * 3_600_000);
    engineCalculatedDays += 1;
  }
  return { engineWorkedMs: engineCalculatedDays > 0 ? engineWorkedMs : null, engineCalculatedDays };
}

export function buildMonthWindow(month: string, timeZone: string) {
  const [year, monthIndex] = month.split("-").map(Number);
  const monthDate = new Date(Date.UTC(year, monthIndex - 1, 1));
  if (!/^\d{4}-\d{2}$/.test(month) || monthIndex < 1 || monthIndex > 12 || !Number.isFinite(monthDate.getTime())) {
    throw new RangeError("Use a valid report month in YYYY-MM format.");
  }
  const nextMonth = new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 7);
  const start = fromZonedTime(`${month}-01T00:00:00.000`, timeZone);
  const end = new Date(fromZonedTime(`${nextMonth}-01T00:00:00.000`, timeZone).getTime() - 1);
  return {
    monthLabel: month,
    start,
    end,
    monthStart: start,
    monthEnd: end,
  };
}

function buildMonthDateWindow(month: string) {
  const [year, monthIndex] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, monthIndex - 1, 1)),
    end: new Date(Date.UTC(year, monthIndex, 1)),
  };
}

export type MonthlyDateRange = { startDate: string; endDate: string };

export function mergeMonthlyDateRanges(ranges: MonthlyDateRange[], monthStart: string, monthEnd: string) {
  const clipped = ranges
    .map(({ startDate, endDate }) => ({
      startDate: startDate > monthStart ? startDate : monthStart,
      endDate: endDate < monthEnd ? endDate : monthEnd,
    }))
    .filter(({ startDate, endDate }) => startDate <= endDate)
    .sort((left, right) => left.startDate.localeCompare(right.startDate) || left.endDate.localeCompare(right.endDate));
  const merged: MonthlyDateRange[] = [];

  for (const range of clipped) {
    const previous = merged.at(-1);
    if (previous && range.startDate <= previous.endDate) {
      if (range.endDate > previous.endDate) previous.endDate = range.endDate;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function monthlyDateLabels(month: string) {
  const { start, end } = buildMonthDateWindow(month);
  return {
    start: start.toISOString().slice(0, 10),
    end: new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10),
  };
}

function countAssignedWorkdays(
  startDate: string,
  endDate: string,
  assignments: readonly EffectiveShiftAssignment[],
  excludedDates: ReadonlySet<string> = new Set(),
  countryCode = "",
) {
  let count = 0;
  for (let timestamp = Date.parse(`${startDate}T00:00:00.000Z`); timestamp <= Date.parse(`${endDate}T00:00:00.000Z`); timestamp += 86_400_000) {
    const date = new Date(timestamp).toISOString().slice(0, 10);
    if (
      !excludedDates.has(date)
      && !isOptionalSriLankanSaturday(countryCode, date)
      && resolveShiftForDate(assignments, date).kind === "ASSIGNED"
    ) count += 1;
  }
  return count;
}

export function buildEmployeeMonthlyReport(
  employee: { timeZone: string },
  month: string,
  sessions: MonthlySession[],
  dailySummaries: MonthlyDailyStatus[] = [],
  monthlyTotals: { totalWorkingDays?: number | null; approvedLeaveDays?: number | null; holidayDays?: number | null; unmatchedScopedHolidayDates?: number; approvedWorkFromHomeDates?: readonly string[] } & Partial<MonthlyOvertimeSummary> = {},
): MonthlyEmployeeReport {
  const window = buildMonthWindow(month, employee.timeZone);
  const filtered = sessions.filter((session) => {
    const sessionDate = new Date(session.startAt);
    return sessionDate >= window.start && sessionDate <= window.end;
  });

  const calculatedStatusSummary = summarizeCalculatedDailyStatuses(
    dailySummaries.filter((day) => day.date.slice(0, 7) === month),
  );
  const engineWorkedTime = summarizeEngineWorkedTime(
    dailySummaries.filter((day) => day.date.slice(0, 7) === month),
  );

  const byDate = new Map<string, MonthlyDaySummary>();
  let totalSessions = 0;
  let completedSessions = 0;
  let activeSessions = 0;
  let totalWorkedMs = 0;

  for (const session of filtered) {
    totalSessions += 1;
    const date = formatInTimeZone(session.startAt, employee.timeZone, "yyyy-MM-dd");
    const current = byDate.get(date) ?? { date, sessions: [], totalWorkedMs: 0 };
    current.sessions.push(session);
    if (session.endAt && session.endAt >= session.startAt) {
      completedSessions += 1;
      const duration = session.endAt.getTime() - session.startAt.getTime();
      current.totalWorkedMs += duration;
      totalWorkedMs += duration;
    } else {
      activeSessions += 1;
    }
    byDate.set(date, current);
  }

  const approvedWorkFromHomeDates = new Set(
    (monthlyTotals.approvedWorkFromHomeDates ?? []).filter((date) => date.slice(0, 7) === month),
  );
  for (const date of approvedWorkFromHomeDates) {
    const current = byDate.get(date) ?? { date, sessions: [], totalWorkedMs: 0 };
    current.approvedWorkFromHome = true;
    byDate.set(date, current);
  }

  const days = [...byDate.values()].sort((left, right) => right.date.localeCompare(left.date));
  return {
    monthLabel: month,
    empty: filtered.length === 0 && approvedWorkFromHomeDates.size === 0,
    summary: {
      totalSessions,
      completedSessions,
      activeSessions,
      totalWorkedMs,
      workFromHomeDays: approvedWorkFromHomeDates.size,
      ...engineWorkedTime,
      totalWorkingDays: monthlyTotals.totalWorkingDays ?? null,
      approvedLeaveDays: monthlyTotals.approvedLeaveDays ?? null,
      ...calculatedStatusSummary,
      ...(monthlyTotals.holidayDays !== undefined ? { holidayDays: monthlyTotals.holidayDays } : {}),
      ...(monthlyTotals.unmatchedScopedHolidayDates !== undefined ? { unmatchedScopedHolidayDates: monthlyTotals.unmatchedScopedHolidayDates } : {}),
      ...(monthlyTotals.pendingExpectedHours !== undefined ? { pendingExpectedOvertimeHours: monthlyTotals.pendingExpectedHours } : {}),
      ...(monthlyTotals.pendingRequestCount !== undefined ? { pendingOvertimeRequestCount: monthlyTotals.pendingRequestCount } : {}),
      ...(monthlyTotals.approvedExpectedHours !== undefined ? { approvedExpectedOvertimeHours: monthlyTotals.approvedExpectedHours } : {}),
      ...(monthlyTotals.approvedRequestCount !== undefined ? { approvedOvertimeRequestCount: monthlyTotals.approvedRequestCount } : {}),
      ...(monthlyTotals.rejectedExpectedHours !== undefined ? { rejectedExpectedOvertimeHours: monthlyTotals.rejectedExpectedHours } : {}),
      ...(monthlyTotals.rejectedRequestCount !== undefined ? { rejectedOvertimeRequestCount: monthlyTotals.rejectedRequestCount } : {}),
      ...(monthlyTotals.recordedActualHours !== undefined ? { recordedActualOvertimeHours: monthlyTotals.recordedActualHours } : {}),
      ...(monthlyTotals.recordedActualEmployees !== undefined ? { recordedActualOvertimeEmployees: monthlyTotals.recordedActualEmployees } : {}),
      ...(monthlyTotals.recordedActualDays !== undefined ? { recordedActualOvertimeDays: monthlyTotals.recordedActualDays } : {}),
      ...(monthlyTotals.conflictingActualDays !== undefined ? { conflictingActualOvertimeDays: monthlyTotals.conflictingActualDays } : {}),
    },
    days,
  };
}

export async function getEmployeeMonthlyReport(
  employee: { id: string; timeZone: string; name: string },
  month: string,
  database: EmployeeMonthlyReportDatabase = prisma,
) {
  const employeeId = employee.id;
  const { start: monthStart, end: monthEnd } = buildMonthWindow(month, employee.timeZone);
  const { start: dateStart, end: dateEnd } = buildMonthDateWindow(month);
  const { start: monthDateStart, end: monthDateEnd } = monthlyDateLabels(month);
  const employeeRecord = await database.employee.findUnique({
    where: { userId: employeeId },
    select: {
      id: true,
      user: { select: { countryCode: true } },
      shift: {
        select: {
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
              lateThresholdMinutes: true,
              earlyDepartureThresholdMinutes: true,
              breakDurationMinutes: true,
              minimumWorkingHours: true,
              overtimeEligible: true,
              roundingRules: true,
              workingDays: true,
            },
          },
        },
      },
    },
  });

  const [sessions, dailyRows, rawPunches, holidays, approvedLeaves, overtimeRequests, approvedWorkFromHomeRequests] = await Promise.all([
    database.workSession.findMany({
      where: {
        record: { employeeId },
        startAt: { gte: monthStart, lte: monthEnd },
      },
      orderBy: { startAt: "asc" },
      select: {
        id: true,
        mode: true,
        startAt: true,
        endAt: true,
      },
    }),
    employeeRecord ? database.attendanceDaily.findMany({
      where: {
        employeeId: employeeRecord.id,
        date: { gte: dateStart, lt: dateEnd },
      },
      select: {
        date: true,
        status: true,
        workingHours: true,
        lateMinutes: true,
        earlyMinutes: true,
        overtimeHours: true,
      },
      orderBy: [{ date: "asc" }, { id: "asc" }],
    }) : Promise.resolve([]),
    employeeRecord ? database.attendanceRaw.findMany({
      where: { employeeId: employeeRecord.id, timestamp: { gte: monthStart, lte: monthEnd } },
      select: { id: true, timestamp: true, punchType: true },
      orderBy: [{ timestamp: "asc" }, { id: "asc" }],
    }) : Promise.resolve([]),
    database.holiday.findMany({
      where: { date: { gte: dateStart, lt: dateEnd } },
      select: { date: true, branch: true, applicableEmployeeGroups: true },
    }),
    employeeRecord ? database.leaveRequest.findMany({
      where: {
        employeeId: employeeRecord.id,
        status: "APPROVED",
        startDate: { lte: new Date(`${monthDateEnd}T00:00:00.000Z`) },
        endDate: { gte: new Date(`${monthDateStart}T00:00:00.000Z`) },
      },
      select: { startDate: true, endDate: true },
    }) : Promise.resolve([]),
    employeeRecord ? database.overtimeRequest.findMany({
      where: { employeeId: employeeRecord.id, date: { gte: dateStart, lt: dateEnd } },
      select: { date: true, status: true, expectedHours: true },
    }) : Promise.resolve([]),
    employeeRecord ? database.workFromHomeRequest.findMany({
      where: {
        employeeId: employeeRecord.id,
        status: "APPROVED",
        date: { gte: dateStart, lt: dateEnd },
      },
      select: { date: true },
    }) : Promise.resolve([]),
  ]);

  const globalHolidayDates = new Set(holidays
    .filter(({ branch, applicableEmployeeGroups }) => branch === "" && applicableEmployeeGroups.length === 0)
    .map(({ date }) => date.toISOString().slice(0, 10)));
  const unmatchedScopedHolidayDates = new Set(holidays
    .filter(({ branch, applicableEmployeeGroups }) => branch !== "" || applicableEmployeeGroups.length > 0)
    .map(({ date }) => date.toISOString().slice(0, 10))
    .filter((date) => !globalHolidayDates.has(date)));
  const holidayDates = globalHolidayDates;
  const dailySummaries: MonthlyDailyStatus[] = dailyRows.map((row) => ({
    date: row.date.toISOString().slice(0, 10),
    status: row.status ?? undefined,
    workingHours: row.workingHours !== null && row.workingHours !== undefined ? Number(row.workingHours) : null,
    lateMinutes: row.lateMinutes,
    earlyMinutes: row.earlyMinutes,
  }));
  const sessionDates = new Set(sessions.map(({ startAt }) => formatInTimeZone(startAt, employee.timeZone, "yyyy-MM-dd")));
  const punchesByDate = new Map<string, typeof rawPunches>();
  for (const punch of rawPunches) {
    const date = formatInTimeZone(punch.timestamp, employee.timeZone, "yyyy-MM-dd");
    const dayPunches = punchesByDate.get(date) ?? [];
    dayPunches.push(punch);
    punchesByDate.set(date, dayPunches);
  }
  const countryCode = employeeRecord?.user?.countryCode ?? "";
  const hasSaturdayActivity = (date: string) =>
    punchesByDate.has(date) || sessionDates.has(date);
  const filteredDailySummaries = dailySummaries.filter(({ date }) =>
    !isOptionalSriLankanSaturday(countryCode, date) || hasSaturdayActivity(date),
  );
  const persistedDates = new Set(filteredDailySummaries.map(({ date }) => date));
  const shiftAssignments: EffectiveShiftAssignment<AttendanceEngineShift>[] = employeeRecord
    ? employeeRecord.shiftAssignments?.length
      ? employeeRecord.shiftAssignments.map(({ effectiveFrom, effectiveTo, shift: assignedShift }) => ({
          effectiveFrom,
          effectiveTo,
          shift: {
            ...assignedShift,
            minimumWorkingHours: assignedShift.minimumWorkingHours?.toString() ?? null,
          },
        }))
      : employeeRecord.shift
        ? [{
            effectiveFrom: new Date("0001-01-01T00:00:00.000Z"),
            effectiveTo: null,
            shift: {
              ...employeeRecord.shift,
              minimumWorkingHours: employeeRecord.shift.minimumWorkingHours?.toString() ?? null,
            },
          }]
        : []
    : [];
  const monthlyGraceAllowancesUsedByDate = monthlyGraceAllowancesUsedBeforeEachDate(
    sessions,
    employee.timeZone,
    shiftAssignments,
  );
  if (employeeRecord) {
    for (let timestamp = dateStart.getTime(); timestamp < dateEnd.getTime(); timestamp += 86_400_000) {
      const date = new Date(timestamp).toISOString().slice(0, 10);
      if (persistedDates.has(date)) continue;
      const dayPunches = punchesByDate.get(date) ?? [];
      const isHoliday = holidayDates.has(date);
      const optionalSaturday = isOptionalSriLankanSaturday(countryCode, date);
      if (optionalSaturday && !hasSaturdayActivity(date)) continue;
      const resolution = resolveShiftForDate(shiftAssignments, date);
      const selectedShift = resolution.kind === "ASSIGNED"
        || (resolution.kind === "NON_WORKING_DAY" && !(optionalSaturday && hasSaturdayActivity(date)))
        ? resolution.shift
        : null;
      const isConfiguredWeekend = resolution.kind === "NON_WORKING_DAY";
      if (dayPunches.length === 0 && !isHoliday && !isConfiguredWeekend) continue;
      if (!selectedShift) {
        filteredDailySummaries.push({
          date,
          status: isHoliday ? "HOLIDAY" : "UNDETERMINED",
          workingHours: null,
          lateMinutes: null,
          earlyMinutes: null,
        });
        continue;
      }

      try {
        if (!employeeRecord) throw new AttendanceEngineConfigurationError("Employee shift assignments are unavailable.");
        const calculation = calculateDailyAttendance({
          employeeId: employeeRecord.id,
          date,
          timeZone: employee.timeZone,
          shift: {
            ...selectedShift,
          },
          punches: dayPunches,
          monthlyGraceAllowancesUsed: monthlyGraceAllowancesUsedByDate.get(date),
          holiday: isHoliday,
        });
        filteredDailySummaries.push({
          date,
          status: calculation.status,
          workingHours: dayPunches.length > 0 ? calculation.workingHours : null,
          lateMinutes: calculation.lateMinutes,
          earlyMinutes: calculation.earlyMinutes,
        });
      } catch (error) {
        if (!(error instanceof AttendanceEngineConfigurationError)) throw error;
        filteredDailySummaries.push({ date, status: "UNDETERMINED", workingHours: null, lateMinutes: null, earlyMinutes: null });
      }
    }
  }
  const totalWorkingDays = shiftAssignments.length > 0
    ? countAssignedWorkdays(monthDateStart, monthDateEnd, shiftAssignments, holidayDates, countryCode)
    : null;
  const approvedLeaveRanges = mergeMonthlyDateRanges(approvedLeaves.map(({ startDate, endDate }) => ({
    startDate: startDate.toISOString().slice(0, 10),
    endDate: endDate.toISOString().slice(0, 10),
  })), monthDateStart, monthDateEnd);
  const attendanceDates = new Set([
    ...filteredDailySummaries.filter(({ status }) => status != null).map(({ date }) => date),
    ...punchesByDate.keys(),
    ...sessions.map(({ startAt }) => formatInTimeZone(startAt, employee.timeZone, "yyyy-MM-dd")),
  ]);
  const leaveExclusionDates = new Set([...holidayDates, ...attendanceDates]);
  const approvedLeaveDays = shiftAssignments.length > 0
    ? approvedLeaveRanges.reduce((sum, range) => sum + countAssignedWorkdays(range.startDate, range.endDate, shiftAssignments, leaveExclusionDates, countryCode), 0)
    : null;
  const overtimeSummary = buildMonthlyOvertimeSummary(
    month,
    overtimeRequests.map((request) => ({
      date: request.date.toISOString().slice(0, 10),
      status: request.status,
      expectedHours: request.expectedHours.toString(),
    })),
    dailyRows.map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      overtimeHours: row.overtimeHours?.toString() ?? null,
    })),
  );

  return buildEmployeeMonthlyReport(
    employee,
    month,
    sessions.map((session) => ({
      id: session.id,
      mode: session.mode,
      startAt: session.startAt,
      endAt: session.endAt,
    })),
    filteredDailySummaries,
    {
      totalWorkingDays,
      approvedLeaveDays,
      holidayDays: holidayDates.size,
      unmatchedScopedHolidayDates: unmatchedScopedHolidayDates.size,
      approvedWorkFromHomeDates: approvedWorkFromHomeRequests.map(({ date }) => date.toISOString().slice(0, 10)),
      ...overtimeSummary,
    },
  );
}

export async function getAdminMonthlyReport(month: string, employeeId?: string) {
  const employees = await prisma.user.findMany({
    where: employeeId ? { id: employeeId, role: { in: ["EMPLOYEE", "ADMIN"] } } : { role: "EMPLOYEE" },
    select: { id: true, name: true, email: true, timeZone: true },
    orderBy: { name: "asc" },
  });

  const rows = await Promise.all(employees.map(async (employee) => ({
    employee,
    report: await getEmployeeMonthlyReport(employee, month),
  })));

  const totalSessions = rows.reduce((sum, item) => sum + item.report.summary.totalSessions, 0);
  const totalWorkedMs = rows.reduce((sum, item) => sum + item.report.summary.totalWorkedMs, 0);
  const rowsWithEngineHours = rows.filter(({ report }) => report.summary.engineWorkedMs !== null && report.summary.engineWorkedMs !== undefined);
  const engineWorkedMs = rowsWithEngineHours.length > 0
    ? rowsWithEngineHours.reduce((sum, item) => sum + (item.report.summary.engineWorkedMs ?? 0), 0)
    : null;
  const engineCalculatedDays = rows.reduce((sum, item) => sum + (item.report.summary.engineCalculatedDays ?? 0), 0);
  const overtimeSummary = aggregateMonthlyOvertimeSummaries(rows.map(({ report }) => ({
    pendingExpectedHours: report.summary.pendingExpectedOvertimeHours,
    pendingRequestCount: report.summary.pendingOvertimeRequestCount,
    approvedExpectedHours: report.summary.approvedExpectedOvertimeHours,
    approvedRequestCount: report.summary.approvedOvertimeRequestCount,
    rejectedExpectedHours: report.summary.rejectedExpectedOvertimeHours,
    rejectedRequestCount: report.summary.rejectedOvertimeRequestCount,
    recordedActualHours: report.summary.recordedActualOvertimeHours,
    recordedActualEmployees: report.summary.recordedActualOvertimeEmployees,
    recordedActualDays: report.summary.recordedActualOvertimeDays,
    conflictingActualDays: report.summary.conflictingActualOvertimeDays,
  })));
  return {
    employees: rows,
    summary: {
      totalSessions,
      totalWorkedMs,
      engineWorkedMs,
      engineCalculatedDays,
      employeeCount: rows.length,
      workFromHomeDays: rows.reduce((total, row) => total + (row.report.summary.workFromHomeDays ?? 0), 0),
      ...overtimeSummary,
    },
  };
}

type MonthlySummaryActor = { id: string; role: Role };
type MonthlySummaryScopeDatabase = Pick<PrismaClient, "user" | "employee" | "department">;

export class MonthlySummaryAccessError extends Error {
  constructor() {
    super("You do not have access to this monthly attendance summary.");
    this.name = "MonthlySummaryAccessError";
  }
}

export async function listMonthlySummaryEmployees(
  actor: MonthlySummaryActor,
  month: string,
  selectedEmployeeId = "",
  database: MonthlySummaryScopeDatabase = prisma,
  selectedDepartmentId = "",
) {
  buildMonthWindow(month, "UTC");
  const selectedId = selectedEmployeeId.trim();
  const selectedDepartment = selectedDepartmentId.trim();
  if (selectedId.length > 100) throw new RangeError("Employee selection is invalid.");
  if (selectedDepartment.length > 100) throw new RangeError("Department selection is invalid.");

  const canReadOrganization = hasPermission(actor.role, "reports:read");
  const canReadDepartment = hasPermission(actor.role, "reports:department:read");
  if (!canReadOrganization && !canReadDepartment) throw new MonthlySummaryAccessError();

  let departmentUserIds: string[] | null = null;
  if (!canReadOrganization) {
    const manager = await database.employee.findUnique({
      where: { userId: actor.id },
      select: { departmentId: true },
    });
    if (!manager?.departmentId) {
      if (selectedId || selectedDepartment) throw new MonthlySummaryAccessError();
      return [];
    }
    if (selectedDepartment && selectedDepartment !== manager.departmentId) {
      throw new MonthlySummaryAccessError();
    }
    const departmentEmployees = await database.employee.findMany({
      where: { departmentId: manager.departmentId },
      select: { userId: true },
    });
    departmentUserIds = [...new Set(departmentEmployees.flatMap(({ userId }) => userId ? [userId] : []))];
    if (selectedId && !departmentUserIds.includes(selectedId)) throw new MonthlySummaryAccessError();
  }

  const where: Prisma.UserWhereInput = {
    role: "EMPLOYEE",
    ...(departmentUserIds !== null
      ? { id: { in: selectedId ? [selectedId] : departmentUserIds } }
      : selectedId ? { id: selectedId } : {}),
    ...(selectedDepartment ? { employee: { is: { departmentId: selectedDepartment } } } : {}),
  };
  const employees = await database.user.findMany({
    where,
    select: {
      id: true,
      name: true,
      timeZone: true,
      employee: {
        select: {
          employeeId: true,
          department: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { name: "asc" },
  });
  if (selectedId && employees.length === 0) throw new MonthlySummaryAccessError();

  return employees.map(({ employee: employeeRecord, ...employee }) => ({
    ...employee,
    employeeCode: employeeRecord?.employeeId ?? null,
    departmentId: employeeRecord?.department?.id ?? null,
    departmentName: employeeRecord?.department?.name ?? null,
  }));
}

export async function getMonthlyAttendanceSummaryReport(
  actor: MonthlySummaryActor,
  month: string,
  selectedEmployeeId = "",
  database: MonthlySummaryScopeDatabase = prisma,
  selectedDepartmentId = "",
) {
  const availableEmployees = await listMonthlySummaryEmployees(actor, month, "", database);
  const selectedId = selectedEmployeeId.trim();
  const selectedDepartment = selectedDepartmentId.trim();
  const departmentEmployees = selectedDepartment
    ? await listMonthlySummaryEmployees(actor, month, "", database, selectedDepartment)
    : availableEmployees;
  if (selectedId && !departmentEmployees.some(({ id }) => id === selectedId)) throw new MonthlySummaryAccessError();
  const employees = selectedId ? departmentEmployees.filter(({ id }) => id === selectedId) : departmentEmployees;
  const availableDepartments = hasPermission(actor.role, "reports:read")
    ? await database.department.findMany({
        select: { id: true, name: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      })
    : [];
  const rows = await Promise.all(employees.map(async (employee) => ({
    employee,
    report: await getEmployeeMonthlyReport(employee, month),
  })));
  const sum = (select: (report: MonthlyEmployeeReport) => number) => rows.reduce((total, row) => total + select(row.report), 0);
  const rowsWithCalculatedStatuses = rows.filter(({ report }) => (report.summary.totalCalculatedDays ?? 0) > 0);
  const sumCalculatedStatuses = (select: (report: MonthlyEmployeeReport) => number | null | undefined) => (
    rowsWithCalculatedStatuses.length > 0
      ? rowsWithCalculatedStatuses.reduce((total, row) => total + (select(row.report) ?? 0), 0)
      : null
  );
  const sumWhenComplete = (select: (report: MonthlyEmployeeReport) => number | null) => (
    rows.length > 0 && rows.every((row) => select(row.report) !== null)
      ? rows.reduce((total, row) => total + (select(row.report) ?? 0), 0)
      : null
  );
  const reportsWithEngineHours = rows.filter(({ report }) => report.summary.engineWorkedMs !== null && report.summary.engineWorkedMs !== undefined);
  const overtimeSummary = aggregateMonthlyOvertimeSummaries(rows.map(({ report }) => ({
    pendingExpectedHours: report.summary.pendingExpectedOvertimeHours,
    pendingRequestCount: report.summary.pendingOvertimeRequestCount,
    approvedExpectedHours: report.summary.approvedExpectedOvertimeHours,
    approvedRequestCount: report.summary.approvedOvertimeRequestCount,
    rejectedExpectedHours: report.summary.rejectedExpectedOvertimeHours,
    rejectedRequestCount: report.summary.rejectedOvertimeRequestCount,
    recordedActualHours: report.summary.recordedActualOvertimeHours,
    recordedActualEmployees: report.summary.recordedActualOvertimeEmployees,
    recordedActualDays: report.summary.recordedActualOvertimeDays,
    conflictingActualDays: report.summary.conflictingActualOvertimeDays,
  })));

  return {
    month,
    employees: rows,
    availableEmployees: departmentEmployees,
    availableDepartments,
    summary: {
      employeeCount: rows.length,
      totalSessions: sum((report) => report.summary.totalSessions),
      totalWorkedMs: sum((report) => report.summary.totalWorkedMs),
      engineWorkedMs: reportsWithEngineHours.length > 0
        ? reportsWithEngineHours.reduce((total, { report }) => total + (report.summary.engineWorkedMs ?? 0), 0)
        : null,
      engineCalculatedDays: sum((report) => report.summary.engineCalculatedDays ?? 0),
      totalWorkingDays: sumWhenComplete((report) => report.summary.totalWorkingDays ?? null),
      presentDays: sumCalculatedStatuses((report) => report.summary.presentDays),
      absentDays: sumCalculatedStatuses((report) => report.summary.absentDays),
      lateDays: sumCalculatedStatuses((report) => report.summary.lateDays),
      earlyOutDays: sumCalculatedStatuses((report) => report.summary.earlyOutDays),
      approvedLeaveDays: sumWhenComplete((report) => report.summary.approvedLeaveDays ?? null),
      holidayDays: sum((report) => report.summary.holidayDays ?? 0),
      unmatchedScopedHolidayDates: rows.reduce((count, row) => Math.max(count, row.report.summary.unmatchedScopedHolidayDates ?? 0), 0),
      missingPunchDays: sumCalculatedStatuses((report) => report.summary.missingPunchDays),
      weekendDays: sumCalculatedStatuses((report) => report.summary.weekendDays),
      undeterminedDays: sumCalculatedStatuses((report) => report.summary.undeterminedDays),
      totalCalculatedDays: sum((report) => report.summary.totalCalculatedDays ?? 0),
      workFromHomeDays: sum((report) => report.summary.workFromHomeDays ?? 0),
      ...overtimeSummary,
    },
  };
}
