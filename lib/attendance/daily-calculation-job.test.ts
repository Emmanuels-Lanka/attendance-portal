import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DailyCalculationCapacityError,
  DailyCalculationRequestError,
  runDailyAttendanceCalculation,
} from "./daily-calculation-job";
import { createDailyCalculationHandler } from "./daily-calculation-http";

const shift = {
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

type TestEmployee = {
  id: string;
  user: { timeZone: string; isActive?: boolean; role?: "EMPLOYEE" | "HR_ADMINISTRATOR" | "ADMIN" } | null;
  shift?: typeof shift | null;
  shiftAssignments?: Array<{
    effectiveFrom: Date;
    effectiveTo: Date | null;
    shift: typeof shift;
  }>;
  punches?: Array<{ id: string; timestamp: Date; punchType: "IN" | "OUT" }>;
  approvedCorrection?: boolean;
};

function createDatabase(
  employees: TestEmployee[],
  lockAcquired = true,
  currentUserOverrides: Record<string, { isActive: boolean; role: "EMPLOYEE" | "HR_ADMINISTRATOR" | "ADMIN" }> = {},
) {
  const dailyRows: Array<Record<string, unknown> & { id: string; employeeId: string; date: Date }> = [];
  const calls = { writes: 0, employeeDayLocks: 0 };
  const database = {
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
      $queryRaw: async (strings: TemplateStringsArray) => {
        if (strings[0].includes("pg_try_advisory_xact_lock")) return [{ locked: lockAcquired }];
        calls.employeeDayLocks += 1;
        return [];
      },
      employee: {
        findMany: async () => employees
          .filter(({ user }) => user !== null
            && user.isActive !== false
            && (user?.role === undefined || user.role === "EMPLOYEE" || user.role === "HR_ADMINISTRATOR"))
          .map(({ id, user }) => ({ id, user: user ? { id, ...user } : null })),
        count: async () => employees.filter(({ user }) => user === null).length,
        findUnique: async ({ where }: { where: { id: string } }) => {
          const employee = employees.find(({ id }) => id === where.id);
          return employee ? {
            id: employee.id,
            userId: employee.user ? employee.id : null,
            user: employee.user ? { ...employee.user, countryCode: "US" } : null,
            shift: Object.hasOwn(employee, "shift") ? employee.shift : shift,
            shiftAssignments: employee.shiftAssignments ?? [],
          } : null;
        },
      },
      user: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          if (currentUserOverrides[where.id]) return currentUserOverrides[where.id];
          const employee = employees.find(({ id }) => id === where.id);
          return employee?.user
            ? { isActive: employee.user.isActive !== false, role: employee.user.role ?? "EMPLOYEE" }
            : null;
        },
      },
      attendanceRaw: {
        findMany: async ({ where }: { where: { employeeId: string } }) =>
          employees.find(({ id }) => id === where.employeeId)?.punches ?? [],
      },
      holiday: {
        findFirst: async () => null,
      },
      attendanceDaily: {
        findMany: async ({ where }: { where: { employeeId: string; date: Date } }) => {
          const employee = employees.find(({ id }) => id === where.employeeId);
          return dailyRows
            .filter((row) => row.employeeId === where.employeeId && row.date.getTime() === where.date.getTime())
            .map(({ id }) => ({
              id,
              correctionRequests: employee?.approvedCorrection ? [{ id: "approved-correction" }] : [],
            }));
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          calls.writes += 1;
          const row = { id: `daily-${calls.writes}`, ...data } as typeof dailyRows[number];
          dailyRows.push(row);
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          calls.writes += 1;
          const index = dailyRows.findIndex(({ id }) => id === where.id);
          if (index < 0) throw new Error("Expected daily row to exist.");
          dailyRows[index] = { ...dailyRows[index], ...data };
          return dailyRows[index];
        },
      },
    }),
  } as never;
  return { database, dailyRows, calls };
}

function punchPair(localDate: string) {
  return [
    { id: "in", timestamp: new Date(`${localDate}T03:00:00.000Z`), punchType: "IN" as const },
    { id: "out", timestamp: new Date(`${localDate}T12:00:00.000Z`), punchType: "OUT" as const },
  ];
}

describe("daily attendance calculation job", () => {
  it("calculates yesterday separately in each employee timezone and persists the existing engine result", async () => {
    const employees: TestEmployee[] = [
      { id: "colombo-employee", user: { timeZone: "Asia/Colombo" }, punches: punchPair("2026-06-16") },
      {
        id: "los-angeles-employee",
        user: { timeZone: "America/Los_Angeles" },
        punches: [
          { id: "in", timestamp: new Date("2026-06-15T15:30:00.000Z"), punchType: "IN" },
          { id: "out", timestamp: new Date("2026-06-16T00:30:00.000Z"), punchType: "OUT" },
        ],
      },
    ];
    const harness = createDatabase(employees);

    const result = await runDailyAttendanceCalculation(
      {},
      new Date("2026-06-16T18:45:00.000Z"),
      harness.database,
    );

    assert.deepEqual(result, {
      lockAcquired: true,
      scanned: 2,
      calculated: 2,
      skippedApprovedCorrections: 0,
      unlinkedEmployees: 0,
      skippedIneligible: 0,
      failed: 0,
      failureCategories: {},
    });
    assert.deepEqual(harness.dailyRows.map(({ employeeId, date, status }) => ({
      employeeId,
      date: date.toISOString().slice(0, 10),
      status,
    })), [
      { employeeId: "colombo-employee", date: "2026-06-16", status: "PRESENT" },
      { employeeId: "los-angeles-employee", date: "2026-06-15", status: "PRESENT" },
    ]);
  });

  it("uses an effective-dated shift for an explicit employee-local date", async () => {
    const priorShift = { ...shift, id: "prior-shift" };
    const currentShift = { ...shift, id: "current-shift" };
    const harness = createDatabase([{
      id: "employee-1",
      user: { timeZone: "Asia/Colombo" },
      shift: null,
      shiftAssignments: [
        { effectiveFrom: new Date("2026-06-01T00:00:00.000Z"), effectiveTo: new Date("2026-06-15T00:00:00.000Z"), shift: priorShift },
        { effectiveFrom: new Date("2026-06-16T00:00:00.000Z"), effectiveTo: null, shift: currentShift },
      ],
      punches: punchPair("2026-06-15"),
    }]);

    await runDailyAttendanceCalculation({ date: "2026-06-15" }, new Date("2026-06-20T00:00:00.000Z"), harness.database);

    assert.equal(harness.dailyRows[0].shiftId, "prior-shift");
  });

  it("is idempotent across repeated job invocations for the same local attendance date", async () => {
    const harness = createDatabase([{
      id: "employee-1",
      user: { timeZone: "UTC" },
      punches: [
        { id: "in", timestamp: new Date("2026-06-15T08:30:00.000Z"), punchType: "IN" },
        { id: "out", timestamp: new Date("2026-06-15T17:30:00.000Z"), punchType: "OUT" },
      ],
    }]);
    const now = new Date("2026-06-16T12:00:00.000Z");

    await runDailyAttendanceCalculation({}, now, harness.database);
    await runDailyAttendanceCalculation({}, now, harness.database);

    assert.equal(harness.dailyRows.length, 1);
    assert.equal(harness.calls.writes, 2);
    assert.equal(harness.dailyRows[0].status, "PRESENT");
  });

  it("uses the existing missing-punch status when only an IN exists", async () => {
    const harness = createDatabase([{
      id: "employee-1",
      user: { timeZone: "UTC" },
      punches: [{ id: "in", timestamp: new Date("2026-06-15T08:30:00.000Z"), punchType: "IN" }],
    }]);

    const result = await runDailyAttendanceCalculation(
      {},
      new Date("2026-06-16T12:00:00.000Z"),
      harness.database,
    );

    assert.equal(result.calculated, 1);
    assert.equal(result.failed, 0);
    assert.equal(harness.dailyRows[0].status, "MISSING_PUNCH");
    assert.equal(harness.dailyRows[0].lastOut, null);
  });

  it("returns a partial failure summary for an unconfigured employee without claiming full success", async () => {
    const harness = createDatabase([
      { id: "configured", user: { timeZone: "UTC" }, punches: punchPair("2026-06-15") },
      { id: "no-shift", user: { timeZone: "UTC" }, shift: null, shiftAssignments: [] },
    ]);

    const result = await runDailyAttendanceCalculation(
      { date: "2026-06-15" },
      new Date("2026-06-20T00:00:00.000Z"),
      harness.database,
    );

    assert.equal(result.calculated, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual(result.failureCategories, { AttendanceEngineConfigurationError: 1 });
    assert.equal(harness.dailyRows.length, 1);
  });

  it("does not overwrite a daily row finalized by an approved correction", async () => {
    const harness = createDatabase([{
      id: "corrected",
      user: { timeZone: "UTC" },
      punches: punchPair("2026-06-15"),
      approvedCorrection: true,
    }]);
    harness.dailyRows.push({
      id: "existing-daily",
      employeeId: "corrected",
      date: new Date("2026-06-15T00:00:00.000Z"),
      status: "MISSING_PUNCH",
    });

    const result = await runDailyAttendanceCalculation(
      { date: "2026-06-15" },
      new Date("2026-06-20T00:00:00.000Z"),
      harness.database,
    );

    assert.equal(result.skippedApprovedCorrections, 1);
    assert.equal(result.calculated, 0);
    assert.equal(result.failed, 0);
    assert.equal(harness.dailyRows[0].status, "MISSING_PUNCH");
    assert.equal(harness.calls.writes, 0);
  });

  it("counts unlinked employees separately and calculates only active linked eligible roles", async () => {
    const harness = createDatabase([
      { id: "employee", user: { timeZone: "UTC", role: "EMPLOYEE" }, punches: punchPair("2026-06-15") },
      { id: "hr", user: { timeZone: "UTC", role: "HR_ADMINISTRATOR" }, punches: punchPair("2026-06-15") },
      { id: "inactive", user: { timeZone: "UTC", role: "EMPLOYEE", isActive: false }, punches: punchPair("2026-06-15") },
      { id: "admin", user: { timeZone: "UTC", role: "ADMIN" }, punches: punchPair("2026-06-15") },
      { id: "unlinked", user: null },
    ]);

    const result = await runDailyAttendanceCalculation(
      { date: "2026-06-15" },
      new Date("2026-06-20T00:00:00.000Z"),
      harness.database,
    );

    assert.equal(result.scanned, 2);
    assert.equal(result.calculated, 2);
    assert.equal(result.unlinkedEmployees, 1);
    assert.deepEqual(harness.dailyRows.map(({ employeeId }) => employeeId), ["employee", "hr"]);
  });

  it("rechecks eligibility after locking the account before calculation", async () => {
    const harness = createDatabase(
      [{ id: "deactivated", user: { timeZone: "UTC", role: "EMPLOYEE" }, punches: punchPair("2026-06-15") }],
      true,
      { deactivated: { isActive: false, role: "EMPLOYEE" } },
    );

    const result = await runDailyAttendanceCalculation(
      { date: "2026-06-15" },
      new Date("2026-06-20T00:00:00.000Z"),
      harness.database,
    );

    assert.equal(result.skippedIneligible, 1);
    assert.equal(result.calculated, 0);
    assert.equal(harness.dailyRows.length, 0);
  });

  it("rejects invalid dates, dates outside the recent completed range, and oversized workforces", async () => {
    const harness = createDatabase([{ id: "employee-1", user: { timeZone: "UTC" } }]);

    await assert.rejects(
      runDailyAttendanceCalculation({ date: "2026-02-30" }, new Date("2026-06-20T00:00:00.000Z"), harness.database),
      DailyCalculationRequestError,
    );
    await assert.rejects(
      runDailyAttendanceCalculation({ date: "2026-06-20" }, new Date("2026-06-20T00:00:00.000Z"), harness.database),
      DailyCalculationRequestError,
    );
    await assert.rejects(
      runDailyAttendanceCalculation({ date: "2026-06-01" }, new Date("2026-06-20T00:00:00.000Z"), harness.database),
      DailyCalculationRequestError,
    );
    const tooMany = createDatabase(Array.from({ length: 101 }, (_, index) => ({
      id: `employee-${index}`,
      user: { timeZone: "UTC" },
    })));
    await assert.rejects(
      runDailyAttendanceCalculation({}, new Date("2026-06-20T00:00:00.000Z"), tooMany.database),
      DailyCalculationCapacityError,
    );
    assert.equal(tooMany.calls.employeeDayLocks, 0);
  });

  it("rejects a concurrent invocation without touching employee attendance", async () => {
    const harness = createDatabase([{ id: "employee-1", user: { timeZone: "UTC" } }], false);

    const result = await runDailyAttendanceCalculation(
      {},
      new Date("2026-06-20T00:00:00.000Z"),
      harness.database,
    );

    assert.equal(result.lockAcquired, false);
    assert.equal(harness.calls.employeeDayLocks, 0);
    assert.equal(harness.calls.writes, 0);
  });

});

describe("daily attendance calculation HTTP trigger", () => {
  const secret = "a-local-test-cron-secret-not-for-production";
  const success = {
    lockAcquired: true,
    scanned: 1,
    calculated: 1,
    skippedApprovedCorrections: 0,
    unlinkedEmployees: 0,
    skippedIneligible: 0,
    failed: 0,
    failureCategories: {},
  };

  it("rejects missing or invalid authorization before invoking the calculation", async () => {
    let calls = 0;
    const handler = createDailyCalculationHandler(async () => {
      calls += 1;
      return success;
    }, () => secret);

    assert.equal((await handler(new Request("http://localhost/api/attendance/calculate-daily"))).status, 401);
    assert.equal((await handler(new Request("http://localhost/api/attendance/calculate-daily", {
      headers: { authorization: "Bearer wrong" },
    }))).status, 401);
    assert.equal(calls, 0);
  });

  it("rejects unconfigured secrets, invalid dates, repeated dates, and unsupported ranges", async () => {
    const handler = createDailyCalculationHandler(async () => success, () => secret);
    const noSecret = createDailyCalculationHandler(async () => success, () => undefined);
    assert.equal((await noSecret(new Request("http://localhost/api/attendance/calculate-daily"))).status, 503);
    const headers = { authorization: `Bearer ${secret}` };
    assert.equal((await handler(new Request("http://localhost/api/attendance/calculate-daily?date=2026-02-30", { headers }))).status, 400);
    assert.equal((await handler(new Request("http://localhost/api/attendance/calculate-daily?date=2026-06-15&date=2026-06-16", { headers }))).status, 400);
    assert.equal((await handler(new Request("http://localhost/api/attendance/calculate-daily?from=2026-06-15&to=2026-06-16", { headers }))).status, 400);
  });

  it("returns failure for partial calculation results and success only for complete summaries", async () => {
    const partial = createDailyCalculationHandler(async () => ({
      ...success,
      calculated: 1,
      failed: 1,
      failureCategories: { AttendanceEngineConfigurationError: 1 },
    }), () => secret);
    const complete = createDailyCalculationHandler(async () => success, () => secret);
    const headers = { authorization: `Bearer ${secret}` };

    assert.equal((await partial(new Request("http://localhost/api/attendance/calculate-daily", { headers }))).status, 500);
    assert.equal((await complete(new Request("http://localhost/api/attendance/calculate-daily", { headers }))).status, 200);
  });

  it("returns conflict when another calculation holds the job lock", async () => {
    const handler = createDailyCalculationHandler(async () => ({
      ...success,
      lockAcquired: false,
      scanned: 0,
      calculated: 0,
    }), () => secret);

    const response = await handler(new Request("http://localhost/api/attendance/calculate-daily", {
      headers: { authorization: `Bearer ${secret}` },
    }));

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "Another daily calculation is currently running.",
    });
  });
});
