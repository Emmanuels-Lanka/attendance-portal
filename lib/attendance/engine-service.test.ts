import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateAndPersistDailyAttendance, type EngineDatabase } from "./engine-service";

const configuredShift = {
  id: "shift-1",
  startTime: new Date("1970-01-01T08:30:00.000Z"),
  endTime: new Date("1970-01-01T17:30:00.000Z"),
  gracePeriodMinutes: 10,
  lateThresholdMinutes: 0,
  earlyDepartureThresholdMinutes: 0,
  breakDurationMinutes: 30,
  minimumWorkingHours: "8",
  overtimeEligible: false,
  roundingRules: null,
  workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
};

type ShiftOverrides = {
  startTime?: Date | null;
  endTime?: Date | null;
  gracePeriodMinutes?: number | null;
  lateThresholdMinutes?: number | null;
  earlyDepartureThresholdMinutes?: number | null;
  breakDurationMinutes?: number | null;
  minimumWorkingHours?: string | null;
  overtimeEligible?: boolean | null;
  roundingRules?: unknown;
  workingDays?: string[];
};

function createHarness(
  raw: Array<{ id: string; timestamp: Date; punchType: "IN" | "OUT" }>,
  shiftOverrides: ShiftOverrides = {},
  isOrganizationHoliday = false,
  existingDaily = false,
  approvedCorrections: Array<{ requestedValues: unknown }> = [],
  approvedSessionMode: "OFFICE" | "WFH" = "WFH",
) {
  let sessionMode = approvedSessionMode;
  let sessionModeWrites = 0;
  const rawBefore = raw.map(({ id, timestamp, punchType }) => [id, timestamp.toISOString(), punchType]);
  const dailyRows: Array<Record<string, unknown> & { id: string }> = existingDaily
    ? [{ id: "daily-existing", employeeId: "employee-1" }]
    : [];
  let creates = 0;
  let updates = 0;
  const database = {
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
      $queryRaw: async () => [],
      employee: {
        findUnique: async () => ({
          id: "employee-1",
          user: { timeZone: "Asia/Colombo", countryCode: "LK" },
          shift: { ...configuredShift, ...shiftOverrides },
        }),
      },
      attendanceRaw: {
        findMany: async () => raw,
      },
      attendanceCorrectionRequest: {
        findMany: async () => approvedCorrections,
      },
      workSession: {
        update: async ({ data }: { data: { mode: "OFFICE" | "WFH" } }) => {
          sessionModeWrites += 1;
          sessionMode = data.mode;
        },
      },
      holiday: {
        findFirst: async ({ where }: { where: { branch: string; applicableEmployeeGroups: { isEmpty: boolean } } }) => (
          isOrganizationHoliday && where.branch === "" && where.applicableEmployeeGroups.isEmpty ? { id: "holiday-1" } : null
        ),
      },
      attendanceDaily: {
        findMany: async () => dailyRows.map(({ id }) => ({ id })),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          creates += 1;
          const row = { id: `daily-${creates}`, ...data };
          dailyRows.push(row);
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          updates += 1;
          const index = dailyRows.findIndex(({ id }) => id === where.id);
          if (index < 0) throw new Error("Expected existing attendance daily row.");
          dailyRows[index] = { ...dailyRows[index], ...data };
          return dailyRows[index];
        },
      },
    }),
  } as unknown as EngineDatabase;
  return {
    database,
    rawBefore,
    raw,
    dailyRows,
    get creates() { return creates; },
    get updates() { return updates; },
    get sessionMode() { return sessionMode; },
    get sessionModeWrites() { return sessionModeWrites; },
  };
}

describe("attendance engine persistence boundary", () => {
  it("reads raw punches and writes only the separate daily result", async () => {
    const raw = [
      { id: "punch-in", timestamp: new Date("2026-06-15T03:00:00.000Z"), punchType: "IN" },
      { id: "punch-out", timestamp: new Date("2026-06-15T12:00:00.000Z"), punchType: "OUT" },
    ];
    const rawBefore = raw.map(({ id, timestamp, punchType }) => [id, timestamp.toISOString(), punchType]);
    const writes: string[] = [];
    const createdDaily: Record<string, unknown>[] = [];
    const database = {
      $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        $queryRaw: async () => [],
        employee: {
          findUnique: async () => ({
            id: "employee-1",
            user: { timeZone: "Asia/Colombo", countryCode: "LK" },
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
              roundingRules: {},
              workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
            },
          }),
        },
        attendanceRaw: {
          findMany: async () => raw,
        },
        attendanceDaily: {
          findMany: async () => [],
          create: async ({ data }: { data: Record<string, unknown> }) => {
            writes.push("attendanceDaily.create");
            createdDaily.push(data);
            return { id: "daily-1", ...data };
          },
          update: async () => {
            writes.push("attendanceDaily.update");
            throw new Error("No existing daily result was expected.");
          },
        },
        attendanceCorrectionRequest: {
          findMany: async () => [],
        },
      }),
    } as unknown as EngineDatabase;

    const result = await calculateAndPersistDailyAttendance("employee-1", "2026-06-15", database);

    assert.equal(result.calculation.workingHours, 9);
    assert.equal(result.attendanceDaily.id, "daily-1");
    assert.deepEqual(writes, ["attendanceDaily.create"]);
    assert.equal(createdDaily[0].employeeId, "employee-1");
    assert.equal(createdDaily[0].shiftId, "shift-1");
    assert.deepEqual(raw.map(({ id, timestamp, punchType }) => [id, timestamp.toISOString(), punchType]), rawBefore);
  });

  it("updates an existing daily row on recalculation without writing raw punches", async () => {
    const raw = [
      { id: "punch-in", timestamp: new Date("2026-06-15T03:00:00.000Z"), punchType: "IN" },
      { id: "punch-out", timestamp: new Date("2026-06-15T12:00:00.000Z"), punchType: "OUT" },
    ];
    let updatedId = "";
    const database = {
      $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        $queryRaw: async () => [],
        employee: {
          findUnique: async () => ({
            id: "employee-1",
            user: { timeZone: "Asia/Colombo", countryCode: "LK" },
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
              roundingRules: {},
              workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
            },
          }),
        },
        attendanceRaw: { findMany: async () => raw },
        attendanceDaily: {
          findMany: async () => [{ id: "daily-existing" }],
          create: async () => {
            throw new Error("Recalculation should update the existing daily row.");
          },
          update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            updatedId = where.id;
            return { id: where.id, ...data };
          },
        },
        attendanceCorrectionRequest: {
          findMany: async () => [],
        },
      }),
    } as unknown as EngineDatabase;

    const result = await calculateAndPersistDailyAttendance("employee-1", "2026-06-15", database);

    assert.equal(updatedId, "daily-existing");
    assert.equal(result.attendanceDaily.id, "daily-existing");
    assert.equal(result.calculation.workingHours, 9);
    assert.deepEqual(raw.map(({ id }) => id), ["punch-in", "punch-out"]);
  });

  it("reapplies approved correction values during raw-punch recalculation without changing raw evidence", async () => {
    const raw = [
      { id: "punch-in", timestamp: new Date("2026-06-15T03:00:00.000Z"), punchType: "IN" as const },
      { id: "punch-out", timestamp: new Date("2026-06-15T12:00:00.000Z"), punchType: "OUT" as const },
    ];
    const approvedCorrections = [{
      requestedValues: { firstIn: "2026-06-15T03:20:00.000Z" },
    }];
    const harness = createHarness(raw, {}, false, true, approvedCorrections);
    const result = await calculateAndPersistDailyAttendance("employee-1", "2026-06-15", harness.database);

    assert.equal(result.calculation.firstIn?.toISOString(), "2026-06-15T03:20:00.000Z");
    assert.equal(result.calculation.lateMinutes, 10);
    assert.equal(result.attendanceDaily.id, "daily-existing");
    assert.deepEqual(raw.map(({ id, timestamp, punchType }) => [id, timestamp.toISOString(), punchType]), harness.rawBefore);
  });

  it("persists Present, Late, and Early Out when the configured data supports each status", async () => {
    const scenarios = [
      {
        name: "Present",
        punches: [
          { id: "in", timestamp: new Date("2026-06-15T03:00:00.000Z"), punchType: "IN" as const },
          { id: "out", timestamp: new Date("2026-06-15T12:00:00.000Z"), punchType: "OUT" as const },
        ],
        status: "PRESENT",
      },
      {
        name: "Late",
        punches: [
          { id: "in", timestamp: new Date("2026-06-15T03:11:00.000Z"), punchType: "IN" as const },
          { id: "out", timestamp: new Date("2026-06-15T12:00:00.000Z"), punchType: "OUT" as const },
        ],
        status: "LATE",
      },
      {
        name: "Early Out",
        punches: [
          { id: "in", timestamp: new Date("2026-06-15T03:00:00.000Z"), punchType: "IN" as const },
          { id: "out", timestamp: new Date("2026-06-15T11:59:00.000Z"), punchType: "OUT" as const },
        ],
        status: "EARLY_OUT",
      },
    ];

    for (const scenario of scenarios) {
      const harness = createHarness(scenario.punches);
      const result = await calculateAndPersistDailyAttendance("employee-1", "2026-06-15", harness.database);
      assert.equal(result.calculation.status, scenario.status, scenario.name);
      assert.equal(result.attendanceDaily.status, scenario.status, scenario.name);
    }
  });

  it("calculates multiple punch periods and preserves the raw evidence", async () => {
    const raw = [
      { id: "in-am", timestamp: new Date("2026-06-15T03:00:00.000Z"), punchType: "IN" as const },
      { id: "out-am", timestamp: new Date("2026-06-15T07:00:00.000Z"), punchType: "OUT" as const },
      { id: "in-pm", timestamp: new Date("2026-06-15T07:30:00.000Z"), punchType: "IN" as const },
      { id: "out-pm", timestamp: new Date("2026-06-15T11:30:00.000Z"), punchType: "OUT" as const },
    ];
    const harness = createHarness(raw, { endTime: new Date("1970-01-01T17:00:00.000Z") });
    const result = await calculateAndPersistDailyAttendance("employee-1", "2026-06-15", harness.database);

    assert.equal(result.calculation.workPeriods.length, 2);
    assert.equal(result.calculation.breakPeriods.length, 1);
    assert.equal(result.calculation.workingHours, 8);
    assert.equal(result.attendanceDaily.workingHours, 8);
    assert.equal(result.calculation.status, "PRESENT");
    assert.deepEqual(harness.raw.map(({ id, timestamp, punchType }) => [id, timestamp.toISOString(), punchType]), harness.rawBefore);
  });

  it("persists incomplete and unusual punch sequences without marking them Present", async () => {
    const incomplete = createHarness([
      { id: "in", timestamp: new Date("2026-06-15T03:00:00.000Z"), punchType: "IN" },
    ]);
    const incompleteResult = await calculateAndPersistDailyAttendance("employee-1", "2026-06-15", incomplete.database);
    assert.equal(incompleteResult.calculation.status, "MISSING_PUNCH");
    assert.equal(incompleteResult.attendanceDaily.status, "MISSING_PUNCH");

    const unusual = createHarness([
      { id: "in-1", timestamp: new Date("2026-06-15T03:00:00.000Z"), punchType: "IN" },
      { id: "in-2", timestamp: new Date("2026-06-15T03:01:00.000Z"), punchType: "IN" },
      { id: "out", timestamp: new Date("2026-06-15T07:00:00.000Z"), punchType: "OUT" },
    ]);
    const unusualResult = await calculateAndPersistDailyAttendance("employee-1", "2026-06-15", unusual.database);
    assert.equal(unusualResult.calculation.status, "UNDETERMINED");
    assert.equal(unusualResult.attendanceDaily.status, "UNDETERMINED");
    assert.equal(unusualResult.calculation.workingHours, null);
  });

  it("keeps status undetermined when optional shift settings are unset", async () => {
    const harness = createHarness([
      { id: "in", timestamp: new Date("2026-06-15T03:00:00.000Z"), punchType: "IN" },
      { id: "out", timestamp: new Date("2026-06-15T12:00:00.000Z"), punchType: "OUT" },
    ], {
      gracePeriodMinutes: null,
      lateThresholdMinutes: null,
      earlyDepartureThresholdMinutes: null,
      minimumWorkingHours: null,
    });
    const result = await calculateAndPersistDailyAttendance("employee-1", "2026-06-15", harness.database);

    assert.equal(result.calculation.status, "UNDETERMINED");
    assert.equal(result.calculation.lateMinutes, null);
    assert.equal(result.attendanceDaily.status, "UNDETERMINED");

    const unsetMinimum = createHarness([
      { id: "in", timestamp: new Date("2026-06-15T03:00:00.000Z"), punchType: "IN" },
      { id: "out", timestamp: new Date("2026-06-15T12:00:00.000Z"), punchType: "OUT" },
    ], { minimumWorkingHours: null });
    const minimumResult = await calculateAndPersistDailyAttendance("employee-1", "2026-06-15", unsetMinimum.database);
    assert.equal(minimumResult.calculation.status, "UNDETERMINED");
    assert.equal(minimumResult.attendanceDaily.status, "UNDETERMINED");
  });

  it("does not guess absence-related statuses when a day has no punches", async () => {
    const harness = createHarness([]);
    const result = await calculateAndPersistDailyAttendance("employee-1", "2026-06-15", harness.database);

    assert.equal(result.calculation.status, "UNDETERMINED");
    assert.equal(result.attendanceDaily.status, "UNDETERMINED");
    assert.equal(result.attendanceDaily.firstIn, null);
    assert.equal(result.attendanceDaily.lastOut, null);
  });

  it("uses an organization-wide holiday status only when there are no punches", async () => {
    const holiday = createHarness([], {}, true);
    const holidayResult = await calculateAndPersistDailyAttendance("employee-1", "2026-06-15", holiday.database);
    assert.equal(holidayResult.calculation.status, "HOLIDAY");
    assert.equal(holidayResult.attendanceDaily.status, "HOLIDAY");

    const workedHoliday = createHarness([
      { id: "in", timestamp: new Date("2026-06-15T03:00:00.000Z"), punchType: "IN" },
      { id: "out", timestamp: new Date("2026-06-15T12:00:00.000Z"), punchType: "OUT" },
    ], {}, true);
    const workedResult = await calculateAndPersistDailyAttendance("employee-1", "2026-06-15", workedHoliday.database);
    assert.equal(workedResult.calculation.status, "PRESENT");
  });

  it("derives Weekend only when the assigned Shift has configured applicable days", async () => {
    const configuredWorkingDays = createHarness([], { workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] });
    const weekend = await calculateAndPersistDailyAttendance("employee-1", "2026-06-14", configuredWorkingDays.database);
    assert.equal(weekend.calculation.status, "WEEKEND");
    assert.equal(weekend.attendanceDaily.status, "WEEKEND");

    const unsetWorkingDays = createHarness([], { workingDays: [] });
    const unknown = await calculateAndPersistDailyAttendance("employee-1", "2026-06-14", unsetWorkingDays.database);
    assert.equal(unknown.calculation.status, "UNDETERMINED");
    assert.equal(unknown.attendanceDaily.status, "UNDETERMINED");
  });

  it("does not treat an optional Sri Lankan Saturday as a missed workday", async () => {
    const weekdayOnly = createHarness([], {
      workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
    });
    const result = await calculateAndPersistDailyAttendance("employee-1", "2026-06-20", weekdayOnly.database);
    assert.equal(result.calculation.status, "WEEKEND");
    assert.equal(result.calculation.shiftId, null);
    assert.deepEqual(result.calculation.punchIssues, []);
    assert.equal(result.attendanceDaily.status, "WEEKEND");
    assert.equal(result.attendanceDaily.shiftId, null);
  });

  it("does not use a weekday shift for actual Sri Lankan Saturday punches", async () => {
    const weekdayOnly = createHarness([
      { id: "in", timestamp: new Date("2026-06-20T03:10:01.000Z"), punchType: "IN" },
      { id: "out", timestamp: new Date("2026-06-20T08:00:00.000Z"), punchType: "OUT" },
    ], {
      workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
    });
    await assert.rejects(
      calculateAndPersistDailyAttendance("employee-1", "2026-06-20", weekdayOnly.database),
      /no Saturday-applicable Shift is assigned/,
    );
    assert.equal(weekdayOnly.creates, 0);
  });

  it("uses the configured Saturday shift and its exact grace boundary for actual work", async () => {
    const exactBoundary = createHarness([
      { id: "in", timestamp: new Date("2026-06-20T03:10:00.000Z"), punchType: "IN" },
      { id: "out", timestamp: new Date("2026-06-20T08:00:00.000Z"), punchType: "OUT" },
    ], {
      startTime: new Date("1970-01-01T08:30:00.000Z"),
      endTime: new Date("1970-01-01T13:30:00.000Z"),
      gracePeriodMinutes: 10,
      workingDays: ["SATURDAY"],
      minimumWorkingHours: "4",
    });
    const onTime = await calculateAndPersistDailyAttendance("employee-1", "2026-06-20", exactBoundary.database);
    assert.equal(onTime.calculation.status, "PRESENT");
    assert.equal(onTime.calculation.lateMinutes, 0);

    const saturdayShift = createHarness([
      { id: "in", timestamp: new Date("2026-06-20T03:10:00.001Z"), punchType: "IN" },
      { id: "out", timestamp: new Date("2026-06-20T08:00:00.000Z"), punchType: "OUT" },
    ], {
      startTime: new Date("1970-01-01T08:30:00.000Z"),
      endTime: new Date("1970-01-01T13:30:00.000Z"),
      gracePeriodMinutes: 10,
      workingDays: ["SATURDAY"],
      minimumWorkingHours: "4",
    });
    const result = await calculateAndPersistDailyAttendance("employee-1", "2026-06-20", saturdayShift.database);
    assert.equal(result.calculation.status, "LATE");
    assert.equal(result.calculation.lateMinutes, 1);
    assert.equal(result.calculation.shiftId, "shift-1");
  });

  it("uses employee-local Saturdays at timezone and month-end boundaries", async () => {
    const localSaturday = createHarness([], {
      workingDays: ["SATURDAY"],
    });
    const result = await calculateAndPersistDailyAttendance("employee-1", "2026-10-31", localSaturday.database);
    assert.equal(result.calculation.status, "WEEKEND");
    assert.deepEqual(result.calculation.punchIssues, []);
  });

  it("recalculates the same employee and date by updating one daily row", async () => {
    const harness = createHarness([
      { id: "in", timestamp: new Date("2026-06-15T03:00:00.000Z"), punchType: "IN" },
      { id: "out", timestamp: new Date("2026-06-15T12:00:00.000Z"), punchType: "OUT" },
    ]);

    const first = await calculateAndPersistDailyAttendance("employee-1", "2026-06-15", harness.database);
    const second = await calculateAndPersistDailyAttendance("employee-1", "2026-06-15", harness.database);

    assert.equal(harness.creates, 1);
    assert.equal(harness.updates, 1);
    assert.equal(harness.dailyRows.length, 1);
    assert.equal(first.attendanceDaily.id, second.attendanceDaily.id);
    assert.deepEqual(first.calculation, second.calculation);
    assert.deepEqual(harness.raw.map(({ id, timestamp, punchType }) => [id, timestamp.toISOString(), punchType]), harness.rawBefore);
  });

  it("keeps an approved session work-mode correction intact during daily recalculation", async () => {
    const harness = createHarness([
      { id: "in", timestamp: new Date("2026-06-15T03:00:00.000Z"), punchType: "IN" },
      { id: "out", timestamp: new Date("2026-06-15T12:00:00.000Z"), punchType: "OUT" },
    ], {}, false, true, [], "WFH");

    await calculateAndPersistDailyAttendance("employee-1", "2026-06-15", harness.database);

    assert.equal(harness.sessionMode, "WFH");
    assert.equal(harness.sessionModeWrites, 0);
  });
});
