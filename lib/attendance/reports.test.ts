import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateMonthlyOvertimeSummaries, buildEmployeeMonthlyReport, buildMonthWindow, buildMonthlyOvertimeSummary, getEmployeeMonthlyReport, mergeMonthlyDateRanges } from "./reports";

describe("employee-local monthly report windows", () => {
  it("uses IANA local midnight for Sri Lanka and Bangladesh month boundaries", () => {
    const colombo = buildMonthWindow("2026-06", "Asia/Colombo");
    const dhaka = buildMonthWindow("2026-06", "Asia/Dhaka");

    assert.equal(colombo.start.toISOString(), "2026-05-31T18:30:00.000Z");
    assert.equal(colombo.end.toISOString(), "2026-06-30T18:29:59.999Z");
    assert.equal(dhaka.start.toISOString(), "2026-05-31T18:00:00.000Z");
    assert.equal(dhaka.end.toISOString(), "2026-06-30T17:59:59.999Z");
  });

  it("includes and excludes sessions using each employee's local month", () => {
    const sessions = [
      { id: "last-may-utc", mode: "OFFICE" as const, startAt: new Date("2026-05-31T18:15:00.000Z"), endAt: null },
      { id: "last-june-utc", mode: "WFH" as const, startAt: new Date("2026-06-30T18:15:00.000Z"), endAt: null },
    ];
    const colombo = buildEmployeeMonthlyReport({ timeZone: "Asia/Colombo" }, "2026-06", sessions);
    const dhaka = buildEmployeeMonthlyReport({ timeZone: "Asia/Dhaka" }, "2026-06", sessions);

    assert.deepEqual(colombo.days.map(({ sessions: entries }) => entries.map(({ id }) => id)), [["last-june-utc"]]);
    assert.deepEqual(dhaka.days.map(({ sessions: entries }) => entries.map(({ id }) => id)), [["last-may-utc"]]);
  });

  it("rejects malformed report months", () => {
    assert.throws(() => buildMonthWindow("2026-13", "Asia/Colombo"), /valid report month/);
    assert.throws(() => buildMonthWindow("2026-6", "Asia/Colombo"), /valid report month/);
  });

  it("handles leap February and December-to-January report windows", () => {
    const leapFebruary = buildMonthWindow("2024-02", "Asia/Colombo");
    const december = buildMonthWindow("2025-12", "Asia/Colombo");
    const january = buildMonthWindow("2026-01", "Asia/Colombo");

    assert.equal(leapFebruary.start.toISOString(), "2024-01-31T18:30:00.000Z");
    assert.equal(leapFebruary.end.toISOString(), "2024-02-29T18:29:59.999Z");
    assert.equal(december.monthLabel, "2025-12");
    assert.equal(january.start.toISOString(), "2025-12-31T18:30:00.000Z");
  });

  it("clips and merges overlapping approved-leave ranges without double counting dates", () => {
    assert.deepEqual(mergeMonthlyDateRanges([
      { startDate: "2026-06-03", endDate: "2026-06-05" },
      { startDate: "2026-06-05", endDate: "2026-06-08" },
      { startDate: "2026-05-28", endDate: "2026-05-30" },
      { startDate: "2026-06-30", endDate: "2026-07-02" },
    ], "2026-06-01", "2026-06-30"), [
      { startDate: "2026-06-03", endDate: "2026-06-08" },
      { startDate: "2026-06-30", endDate: "2026-06-30" },
    ]);
  });

  it("includes engine-calculated daily statuses in the monthly summary when available", () => {
    const report = buildEmployeeMonthlyReport(
      { timeZone: "Asia/Colombo" },
      "2026-06",
      [
        { id: "session-1", mode: "OFFICE", startAt: new Date("2026-06-02T08:45:00.000Z"), endAt: new Date("2026-06-02T17:20:00.000Z") },
        { id: "session-2", mode: "OFFICE", startAt: new Date("2026-06-03T08:45:00.000Z"), endAt: new Date("2026-06-03T17:20:00.000Z") },
      ],
      [
        { date: "2026-06-02", status: "PRESENT" },
        { date: "2026-06-03", status: "LATE" },
        { date: "2026-06-04", status: "EARLY_OUT" },
        { date: "2026-06-05", status: "MISSING_PUNCH" },
        { date: "2026-06-06", status: "ABSENT" },
      ],
    );

    assert.equal(report.summary.presentDays, 1);
    assert.equal(report.summary.lateDays, 1);
    assert.equal(report.summary.earlyOutDays, 1);
    assert.equal(report.summary.missingPunchDays, 1);
    assert.equal(report.summary.absentDays, 1);
    assert.equal(report.summary.totalCalculatedDays, 5);
  });

  it("includes date-only engine rows on the first day of a UTC+14 employee month", () => {
    const report = buildEmployeeMonthlyReport(
      { timeZone: "Pacific/Kiritimati" },
      "2026-06",
      [],
      [{ date: "2026-06-01", status: "HOLIDAY" }],
    );

    assert.equal(report.summary.holidayDays, 1);
    assert.equal(report.summary.totalCalculatedDays, 1);
    assert.equal(report.summary.absentDays, 0);
  });

  it("counts duplicate daily rows once and marks conflicting statuses undetermined", () => {
    const report = buildEmployeeMonthlyReport({ timeZone: "UTC" }, "2026-06", [], [
      { date: "2026-06-01", status: "PRESENT" },
      { date: "2026-06-01", status: "PRESENT" },
      { date: "2026-06-02", status: "LATE" },
      { date: "2026-06-02", status: "EARLY_OUT" },
    ], { totalWorkingDays: 22, approvedLeaveDays: 1, holidayDays: 1 });

    assert.equal(report.summary.presentDays, 1);
    assert.equal(report.summary.lateDays, 0);
    assert.equal(report.summary.earlyOutDays, 0);
    assert.equal(report.summary.undeterminedDays, 1);
    assert.equal(report.summary.totalCalculatedDays, 2);
    assert.equal(report.summary.totalWorkingDays, 22);
    assert.equal(report.summary.approvedLeaveDays, 1);
    assert.equal(report.summary.holidayDays, 1);
  });

  it("keeps engine working hours separate from session duration", () => {
    const report = buildEmployeeMonthlyReport({ timeZone: "UTC" }, "2026-06", [
      { id: "session-1", mode: "OFFICE", startAt: new Date("2026-06-01T08:00:00.000Z"), endAt: new Date("2026-06-01T17:00:00.000Z") },
    ], [{ date: "2026-06-01", status: "PRESENT", workingHours: 8 }]);

    assert.equal(report.summary.totalWorkedMs, 9 * 3_600_000);
    assert.equal(report.summary.engineWorkedMs, 8 * 3_600_000);
    assert.equal(report.summary.engineCalculatedDays, 1);
  });

  it("does not present missing engine status data as zero attendance", () => {
    const report = buildEmployeeMonthlyReport({ timeZone: "UTC" }, "2026-06", []);

    assert.equal(report.summary.presentDays, null);
    assert.equal(report.summary.lateDays, null);
    assert.equal(report.summary.earlyOutDays, null);
    assert.equal(report.summary.absentDays, null);
    assert.equal(report.summary.totalCalculatedDays, 0);
  });

  it("keeps requested overtime by status separate from explicitly recorded actual overtime", () => {
    const overtime = buildMonthlyOvertimeSummary("2024-02", [
      { date: "2024-02-02", status: "PENDING", expectedHours: "1.25" },
      { date: "2024-02-03", status: "APPROVED", expectedHours: "2.50" },
      { date: "2024-02-04", status: "REJECTED", expectedHours: "0.50" },
      { date: "2024-01-31", status: "APPROVED", expectedHours: "8.00" },
    ], [
      { date: "2024-02-02", overtimeHours: "1.25" },
      { date: "2024-02-02", overtimeHours: "1.25" },
      { date: "2024-02-29", overtimeHours: "2.00" },
      { date: "2024-02-10", overtimeHours: null },
    ]);

    assert.equal(overtime.pendingExpectedHours, 1.25);
    assert.equal(overtime.approvedExpectedHours, 2.5);
    assert.equal(overtime.rejectedExpectedHours, 0.5);
    assert.equal(overtime.recordedActualHours, 3.25);
    assert.equal(overtime.recordedActualDays, 2);
    assert.equal(overtime.conflictingActualDays, 0);
  });

  it("does not infer actual overtime from approved requests and excludes conflicting daily values", () => {
    const overtime = buildMonthlyOvertimeSummary("2026-10", [
      { date: "2026-10-01", status: "APPROVED", expectedHours: "4" },
    ], [
      { date: "2026-10-02", overtimeHours: "1.5" },
      { date: "2026-10-02", overtimeHours: "2" },
    ]);

    assert.equal(overtime.approvedExpectedHours, 4);
    assert.equal(overtime.recordedActualHours, null);
    assert.equal(overtime.recordedActualDays, 0);
    assert.equal(overtime.conflictingActualDays, 1);
  });

  it("reports zero actual overtime only when a daily row explicitly stores zero", () => {
    const absent = buildMonthlyOvertimeSummary("2026-10", [], []);
    const recordedZero = buildMonthlyOvertimeSummary("2026-10", [], [
      { date: "2026-10-02", overtimeHours: "0" },
    ]);

    assert.equal(absent.recordedActualHours, null);
    assert.equal(absent.recordedActualDays, 0);
    assert.equal(recordedZero.recordedActualHours, 0);
    assert.equal(recordedZero.recordedActualDays, 1);
  });

  it("aggregates OT by employees while preserving actual-hour coverage and conflict counts", () => {
    const overtime = aggregateMonthlyOvertimeSummaries([
      { pendingExpectedHours: 1, pendingRequestCount: 1, approvedExpectedHours: 2, approvedRequestCount: 1, rejectedExpectedHours: 0, rejectedRequestCount: 0, recordedActualHours: 3, recordedActualDays: 2, conflictingActualDays: 0 },
      { pendingExpectedHours: 0, pendingRequestCount: 0, approvedExpectedHours: 4, approvedRequestCount: 2, rejectedExpectedHours: 1, rejectedRequestCount: 1, recordedActualHours: null, recordedActualDays: 0, conflictingActualDays: 1 },
    ]);

    assert.equal(overtime.pendingExpectedHours, 1);
    assert.equal(overtime.approvedExpectedHours, 6);
    assert.equal(overtime.approvedRequestCount, 3);
    assert.equal(overtime.rejectedExpectedHours, 1);
    assert.equal(overtime.recordedActualHours, 3);
    assert.equal(overtime.recordedActualEmployees, 1);
    assert.equal(overtime.recordedActualDays, 2);
    assert.equal(overtime.conflictingActualDays, 1);
  });

  it("shows approved WFH dates without inventing sessions and deduplicates dates", () => {
    const report = buildEmployeeMonthlyReport({ timeZone: "Asia/Colombo" }, "2026-06", [], [], {
      approvedWorkFromHomeDates: ["2026-06-03", "2026-06-03", "2026-07-01"],
    });

    assert.equal(report.empty, false);
    assert.equal(report.summary.workFromHomeDays, 1);
    assert.equal(report.summary.totalSessions, 0);
    assert.deepEqual(report.days.map(({ date, sessions, approvedWorkFromHome, totalWorkedMs }) => ({
      date, sessions, approvedWorkFromHome, totalWorkedMs,
    })), [{ date: "2026-06-03", sessions: [], approvedWorkFromHome: true, totalWorkedMs: 0 }]);
  });

  it("uses effective shift assignments, holidays, leave, and saved corrections", async () => {
    const calls: Record<string, unknown> = {};
    const database = {
      employee: {
        findUnique: async ({ where, select }: { where: { userId: string }; select: Record<string, unknown> }) => {
          calls.employeeWhere = where;
          calls.employeeSelect = select;
          return {
            id: "employee-record-1",
            shift: null,
            shiftAssignments: [{
              effectiveFrom: new Date("0001-01-01T00:00:00.000Z"),
              effectiveTo: null,
              shift: {
                id: "shift-1",
                startTime: new Date("1970-01-01T08:30:00.000Z"),
                endTime: new Date("1970-01-01T17:30:00.000Z"),
                gracePeriodMinutes: 10,
                lateThresholdMinutes: 0,
                earlyDepartureThresholdMinutes: 0,
                breakDurationMinutes: 0,
                minimumWorkingHours: "8",
                overtimeEligible: false,
                roundingRules: null,
                workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
              },
            }],
          };
        },
      },
      workSession: {
        findMany: async ({ where }: { where: { record: { employeeId: string } } }) => {
          calls.sessionWhere = where;
          return [{ id: "session-1", mode: "OFFICE", startAt: new Date("2026-06-01T02:30:00.000Z"), endAt: new Date("2026-06-01T11:30:00.000Z") }];
        },
      },
      attendanceDaily: {
        findMany: async ({ where }: { where: { employeeId: string } }) => {
          calls.dailyWhere = where;
          return [{
            date: new Date("2026-06-01T00:00:00.000Z"),
            status: "LATE",
            workingHours: 7.5,
            lateMinutes: 5,
            earlyMinutes: 0,
            overtimeHours: "1.5",
          }];
        },
      },
      attendanceRaw: {
        findMany: async ({ where, select }: { where: { employeeId: string }; select: Record<string, boolean> }) => {
          calls.rawWhere = where;
          calls.rawSelect = select;
          return [
            { id: "punch-in", timestamp: new Date("2026-06-05T03:15:00.000Z"), punchType: "IN" },
            { id: "punch-out", timestamp: new Date("2026-06-05T12:00:00.000Z"), punchType: "OUT" },
            { id: "missing-out-in", timestamp: new Date("2026-06-08T03:00:00.000Z"), punchType: "IN" },
            { id: "missing-in-out", timestamp: new Date("2026-06-09T12:00:00.000Z"), punchType: "OUT" },
          ];
        },
      },
      holiday: {
        findMany: async () => [
          { date: new Date("2026-06-03T00:00:00.000Z"), branch: "", applicableEmployeeGroups: [] },
          { date: new Date("2026-06-12T00:00:00.000Z"), branch: "Colombo", applicableEmployeeGroups: [] },
        ],
      },
      leaveRequest: {
        findMany: async ({ where }: { where: { employeeId: string; status: string } }) => {
          calls.leaveWhere = where;
          return [
            { startDate: new Date("2026-06-01T00:00:00.000Z"), endDate: new Date("2026-06-03T00:00:00.000Z") },
            { startDate: new Date("2026-06-03T00:00:00.000Z"), endDate: new Date("2026-06-04T00:00:00.000Z") },
          ];
        },
      },
      overtimeRequest: {
        findMany: async ({ where }: { where: { employeeId: string; date: unknown } }) => {
          calls.overtimeWhere = where;
          return [
            { date: new Date("2026-06-01T00:00:00.000Z"), status: "APPROVED", expectedHours: "2.25" },
            { date: new Date("2026-06-02T00:00:00.000Z"), status: "PENDING", expectedHours: "0.5" },
            { date: new Date("2026-06-04T00:00:00.000Z"), status: "REJECTED", expectedHours: "0.75" },
          ];
        },
      },
      workFromHomeRequest: {
        findMany: async ({ where }: { where: { employeeId: string; status: string; date: unknown } }) => {
          calls.workFromHomeWhere = where;
          return [{ date: new Date("2026-06-10T00:00:00.000Z") }];
        },
      },
    } as never;

    const report = await getEmployeeMonthlyReport({
      id: "user-1",
      name: "Alex Employee",
      timeZone: "Asia/Colombo",
    }, "2026-06", database);

    assert.deepEqual(calls.employeeWhere, { userId: "user-1" });
    assert.ok("shiftAssignments" in (calls.employeeSelect as Record<string, unknown>));
    assert.deepEqual(calls.sessionWhere, { record: { employeeId: "user-1" }, startAt: { gte: new Date("2026-05-31T18:30:00.000Z"), lte: new Date("2026-06-30T18:29:59.999Z") } });
    assert.deepEqual(calls.dailyWhere, { employeeId: "employee-record-1", date: { gte: new Date("2026-06-01T00:00:00.000Z"), lt: new Date("2026-07-01T00:00:00.000Z") } });
    assert.deepEqual(calls.rawWhere, { employeeId: "employee-record-1", timestamp: { gte: new Date("2026-05-31T18:30:00.000Z"), lte: new Date("2026-06-30T18:29:59.999Z") } });
    assert.deepEqual(calls.rawSelect, { id: true, timestamp: true, punchType: true });
    assert.equal("location" in (calls.rawSelect as Record<string, boolean>), false);
    assert.equal((calls.leaveWhere as { status: string }).status, "APPROVED");
    assert.deepEqual(calls.overtimeWhere, { employeeId: "employee-record-1", date: { gte: new Date("2026-06-01T00:00:00.000Z"), lt: new Date("2026-07-01T00:00:00.000Z") } });
    assert.deepEqual(calls.workFromHomeWhere, {
      employeeId: "employee-record-1",
      status: "APPROVED",
      date: { gte: new Date("2026-06-01T00:00:00.000Z"), lt: new Date("2026-07-01T00:00:00.000Z") },
    });
    assert.equal(report.summary.workFromHomeDays, 1);
    assert.equal(report.days.find(({ date }) => date === "2026-06-10")?.approvedWorkFromHome, true);
    assert.equal(report.summary.totalWorkingDays, 21);
    assert.equal(report.summary.approvedLeaveDays, 2);
    assert.equal(report.summary.holidayDays, 1);
    assert.equal(report.summary.unmatchedScopedHolidayDates, 1);
    assert.equal(report.summary.lateDays, 2);
    assert.equal(report.summary.missingPunchDays, 2);
    assert.equal(report.summary.weekendDays, 8);
    assert.equal(report.summary.undeterminedDays, 0);
    assert.equal(report.summary.engineWorkedMs, (7.5 + 8.75) * 3_600_000);
    assert.equal(report.summary.engineCalculatedDays, 4);
    assert.equal(report.summary.recordedActualOvertimeHours, 1.5);
    assert.equal(report.summary.recordedActualOvertimeDays, 1);
    assert.equal(report.summary.approvedExpectedOvertimeHours, 2.25);
    assert.equal(report.summary.pendingExpectedOvertimeHours, 0.5);
    assert.equal(report.summary.rejectedExpectedOvertimeHours, 0.75);
  });

  it("excludes unworked Sri Lankan Saturdays from monthly workday and absence totals", async () => {
    const shift = {
      id: "weekday",
      startTime: new Date("1970-01-01T08:00:00.000Z"),
      endTime: new Date("1970-01-01T17:30:00.000Z"),
      gracePeriodMinutes: 10,
      lateThresholdMinutes: 30,
      earlyDepartureThresholdMinutes: 10,
      breakDurationMinutes: 60,
      minimumWorkingHours: "9",
      overtimeEligible: false,
      roundingRules: null,
      workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
    };
    const saturdayShift = {
      ...shift,
      id: "saturday",
      startTime: new Date("1970-01-01T08:30:00.000Z"),
      endTime: new Date("1970-01-01T13:30:00.000Z"),
      workingDays: ["SATURDAY"],
      minimumWorkingHours: "4",
    };

    async function reportWith(assignSaturdayShift: boolean, punches: Array<{ id: string; timestamp: Date; punchType: "IN" | "OUT" }> = []) {
      const database = {
        employee: {
          findUnique: async () => ({
            id: "employee-record-1",
            user: { countryCode: "LK" },
            shift: null,
            shiftAssignments: [
              {
                effectiveFrom: new Date("0001-01-01T00:00:00.000Z"),
                effectiveTo: null,
                shift,
              },
              ...(assignSaturdayShift ? [{
                effectiveFrom: new Date("0001-01-01T00:00:00.000Z"),
                effectiveTo: null,
                shift: saturdayShift,
              }] : []),
            ],
          }),
        },
        workSession: { findMany: async () => [] },
        attendanceDaily: {
          findMany: async () => punches.length === 0 ? [{
            date: new Date("2026-10-31T00:00:00.000Z"),
            status: "ABSENT",
            workingHours: null,
            lateMinutes: null,
            earlyMinutes: null,
            overtimeHours: null,
          }] : [],
        },
        attendanceRaw: { findMany: async () => punches },
        holiday: { findMany: async () => [] },
        leaveRequest: { findMany: async () => [] },
        overtimeRequest: { findMany: async () => [] },
        workFromHomeRequest: { findMany: async () => [] },
      } as never;
      return getEmployeeMonthlyReport(
        { id: "user-1", name: "Employee", timeZone: "Asia/Colombo" },
        "2026-10",
        database,
      );
    }

    const withoutWeekendShift = await reportWith(false);
    const withWeekendShift = await reportWith(true);
    for (const report of [withoutWeekendShift, withWeekendShift]) {
      assert.equal(report.summary.totalWorkingDays, 22);
      assert.equal(report.summary.absentDays, 0);
      assert.equal(report.summary.lateDays, 0);
      assert.equal(report.summary.missingPunchDays, 0);
      assert.equal(report.summary.undeterminedDays, 0);
    }

    const saturdayPunches = [
      { id: "saturday-in", timestamp: new Date("2026-10-31T03:10:00.001Z"), punchType: "IN" },
      { id: "saturday-out", timestamp: new Date("2026-10-31T08:00:00.000Z"), punchType: "OUT" },
    ] as const;
    const actualSaturday = await reportWith(true, [...saturdayPunches]);
    assert.equal(actualSaturday.summary.totalWorkingDays, 22);
    assert.equal(actualSaturday.summary.lateDays, 1);
    assert.equal(actualSaturday.summary.absentDays, 0);

    const unresolvedSaturday = await reportWith(false, [...saturdayPunches]);
    assert.equal(unresolvedSaturday.summary.totalWorkingDays, 22);
    assert.equal(unresolvedSaturday.summary.lateDays, 0);
    assert.equal(unresolvedSaturday.summary.undeterminedDays, 1);
  });

});