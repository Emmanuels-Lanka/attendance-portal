import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role, ShiftWeekday } from "@prisma/client";
import {
  assertLeaveBalanceCoversRequest,
  calculateApprovedLeaveUsage,
  calculateAvailableLeaveBalance,
  getLeaveEntitlement,
  getManagedLeaveBalance,
  InsufficientLeaveBalanceError,
  LeaveBalanceAccessError,
  LeaveEntitlementAccessError,
  LeaveEntitlementEmployeeNotFoundError,
  LeaveEntitlementTypeNotFoundError,
  LeaveUsageEmployeeConflictError,
  LeaveUsageSourceConflictError,
  listOwnLeaveBalanceCredits,
  listOwnLeaveBalances,
  listLeaveEntitlementEmployees,
  listLeaveTypesForEntitlements,
  setLeaveEntitlement,
} from "@/lib/leave/balance-service";
import { leaveEntitlementSchema } from "@/lib/leave/validation";

const admin = { id: "admin-user", role: Role.ADMIN };
const hrAdmin = { id: "hr-user", role: Role.HR_ADMINISTRATOR };
const employee = { id: "employee-user", role: Role.EMPLOYEE };
const input = {
  employeeId: "employee-1",
  leaveTypeId: "leave-type-1",
  periodStart: "2026-04-01",
  periodEnd: "2027-03-31",
  openingBalance: "2",
  entitlement: "14",
  carryForward: "1.5",
  reason: "Annual allowance for the 2026/27 period",
};

function createEntitlementDatabaseStub() {
  const employeeIds = new Set(["employee-1"]);
  const employeeRoles = new Map<string, Role>([["employee-1", Role.EMPLOYEE]]);
  const leaveTypeIds = new Set(["leave-type-1", "leave-type-2"]);
  const records = new Map<string, Record<string, unknown>>();
  const audits: Record<string, unknown>[] = [];
  let entitlementLookups = 0;
  let nextId = 1;
  const tx = {
    employee: {
      findMany: async () => [{ id: "employee-1", name: "Ravi Employee", employeeId: "EMP-1", department: { name: "People" } }],
      findUnique: async ({ where }: { where: { id?: string; userId?: string } }) => {
        if (where.id) return employeeIds.has(where.id) ? { id: where.id, name: "Ravi Employee", employeeId: "EMP-1", userId: "employee-user", user: { role: employeeRoles.get(where.id) ?? Role.EMPLOYEE }, department: { name: "People" }, shift: { workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] } } : null;
        if (where.userId === "employee-user") return { id: "employee-1", userId: "employee-user", shift: { workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] } };
        return null;
      },
    },
    leaveType: {
      findMany: async () => [{ id: "leave-type-1", name: "Annual" }],
      findUnique: async ({ where }: { where: { id: string } }) => leaveTypeIds.has(where.id) ? { id: where.id } : null,
    },
    leaveEntitlement: {
      findMany: async ({ where }: { where: { employeeId: string; periodStart: { lte: Date }; periodEnd: { gte: Date } } }) => [...records.values()]
        .filter((record) => record.employeeId === where.employeeId)
        .map((record) => ({ ...record, leaveType: { id: record.leaveTypeId, name: "Annual" } })),
      findUnique: async ({ where }: { where: { employeeId_leaveTypeId_periodStart_periodEnd: { employeeId: string; leaveTypeId: string; periodStart: Date; periodEnd: Date } } }) => {
        entitlementLookups += 1;
        const key = entitlementKey(where.employeeId_leaveTypeId_periodStart_periodEnd);
        return records.get(key) ?? null;
      },
      upsert: async ({ where, create, update }: {
        where: { employeeId_leaveTypeId_periodStart_periodEnd: { employeeId: string; leaveTypeId: string; periodStart: Date; periodEnd: Date } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const key = entitlementKey(where.employeeId_leaveTypeId_periodStart_periodEnd);
        const existing = records.get(key);
        const saved = existing
          ? { ...existing, ...update }
          : { id: `entitlement-${nextId++}`, ...create };
        records.set(key, saved);
        return saved;
      },
    },
    leaveRequest: {
      findMany: async () => [{
        id: "approved-request-1",
        employeeId: "employee-1",
        leaveTypeId: "leave-type-1",
        status: "APPROVED",
        startDate: new Date("2026-06-01T00:00:00.000Z"),
        endDate: new Date("2026-06-05T00:00:00.000Z"),
      }],
    },
    holiday: {
      findMany: async () => [{ date: new Date("2026-06-03T00:00:00.000Z"), branch: "", applicableEmployeeGroups: [] }],
    },
    attendanceAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return { id: `audit-${audits.length}` };
      },
    },
  };
  const database = {
    employee: {
      findMany: async () => [{ id: "employee-1", name: "Ravi Employee", employeeId: "EMP-1", department: { name: "People" } }],
      findUnique: tx.employee.findUnique,
    },
    leaveType: {
      findMany: async () => [{ id: "leave-type-1", name: "Annual" }],
      findUnique: tx.leaveType.findUnique,
    },
    leaveEntitlement: tx.leaveEntitlement,
    leaveRequest: tx.leaveRequest,
    holiday: tx.holiday,
    $transaction: async <T>(operation: (transaction: typeof tx) => Promise<T>) => operation(tx),
  } as never;
  return { database, tx, records, audits, employeeIds, employeeRoles, leaveTypeIds, get entitlementLookups() { return entitlementLookups; } };
}

function entitlementKey(key: { employeeId: string; leaveTypeId: string; periodStart: Date; periodEnd: Date }) {
  return `${key.employeeId}:${key.leaveTypeId}:${key.periodStart.toISOString()}:${key.periodEnd.toISOString()}`;
}

function createOwnBalanceDatabaseStub(employeeExists = true, entitlements = [{
  id: "entitlement-1",
  periodStart: new Date("2026-04-01T00:00:00.000Z"),
  periodEnd: new Date("2027-03-31T00:00:00.000Z"),
  openingBalance: "2",
  entitlement: "14",
  carryForward: "1.5",
  leaveType: { id: "leave-type-1", name: "Annual" },
}]) {
  const calls: { employee?: unknown; entitlements?: unknown } = {};
  const database = {
    employee: {
      findUnique: async (args: unknown) => {
        calls.employee = args;
        return employeeExists ? { id: "employee-1" } : null;
      },
    },
    leaveEntitlement: {
      findMany: async (args: unknown) => {
        calls.entitlements = args;
        return entitlements;
      },
    },
  } as never;
  return { database, calls };
}

describe("Leave entitlement validation", () => {
  it("requires Employee, Leave Type, and valid explicit entitlement-period boundaries", () => {
    assert.equal(leaveEntitlementSchema.safeParse(input).success, true);
    assert.equal(leaveEntitlementSchema.safeParse({ ...input, employeeId: "" }).success, false);
    assert.equal(leaveEntitlementSchema.safeParse({ ...input, leaveTypeId: "" }).success, false);
    assert.equal(leaveEntitlementSchema.safeParse({ ...input, periodStart: "2026-02-30" }).success, false);
    assert.equal(leaveEntitlementSchema.safeParse({ ...input, periodEnd: "2026-03-31" }).success, false);
    assert.equal(leaveEntitlementSchema.safeParse({ ...input, reason: " " }).success, false);
  });

  it("accepts zero and precise decimal quantities, and rejects negative or over-precision values", () => {
    const parsed = leaveEntitlementSchema.parse({ ...input, openingBalance: "0", entitlement: "1.25", carryForward: "0.05" });
    assert.equal(parsed.openingBalance.toString(), "0");
    assert.equal(parsed.entitlement.toString(), "1.25");
    assert.equal(parsed.carryForward.toString(), "0.05");
    assert.equal(leaveEntitlementSchema.safeParse({ ...input, openingBalance: "-1" }).success, false);
    assert.equal(leaveEntitlementSchema.safeParse({ ...input, entitlement: "1.001" }).success, false);
  });
});

describe("Leave entitlement management", () => {
  it("allows HR to create, read, and update employee-specific entitlements while denying employees", async () => {
    const stub = createEntitlementDatabaseStub();
    await assert.rejects(getLeaveEntitlement(employee, input, stub.database), LeaveEntitlementAccessError);
    await assert.rejects(setLeaveEntitlement(employee, input, stub.database), LeaveEntitlementAccessError);
    assert.equal(stub.records.size, 0);

    await setLeaveEntitlement(hrAdmin, input, stub.database);
    assert.equal((await getLeaveEntitlement(hrAdmin, input, stub.database))?.entitlement.toString(), "14");
    await setLeaveEntitlement(hrAdmin, { ...input, entitlement: "16", carryForward: "2", reason: "Approved carry-forward adjustment" }, stub.database);
    assert.equal(stub.audits.at(-1)?.actorId, hrAdmin.id);
    assert.equal(stub.audits.at(-1)?.reason, "Approved carry-forward adjustment");
    assert.deepEqual(stub.audits.at(-1)?.newValues && (stub.audits.at(-1)?.newValues as { changedFields: string[] }).changedFields, ["entitlement", "carryForward"]);
  });

  it("denies HR direct writes and reads for administrator accounts without exposing their entitlement", async () => {
    const stub = createEntitlementDatabaseStub();
    stub.employeeIds.add("super-admin-employee");
    stub.employeeRoles.set("super-admin-employee", Role.ADMIN);
    stub.employeeIds.add("hr-admin-employee");
    stub.employeeRoles.set("hr-admin-employee", Role.HR_ADMINISTRATOR);

    for (const employeeId of ["super-admin-employee", "hr-admin-employee"]) {
      const restrictedInput = { ...input, employeeId };
      await assert.rejects(setLeaveEntitlement(hrAdmin, restrictedInput, stub.database), LeaveEntitlementEmployeeNotFoundError);
      assert.equal(await getLeaveEntitlement(hrAdmin, restrictedInput, stub.database), null);
      await assert.rejects(getManagedLeaveBalance(hrAdmin, restrictedInput, stub.database), LeaveEntitlementEmployeeNotFoundError);
    }
    assert.equal(stub.records.size, 0);
    assert.equal(stub.audits.length, 0);
    assert.equal(stub.entitlementLookups, 0);
  });

  it("preserves Super Administrator access to administrator-account entitlements", async () => {
    const stub = createEntitlementDatabaseStub();
    stub.employeeIds.add("hr-admin-employee");
    stub.employeeRoles.set("hr-admin-employee", Role.HR_ADMINISTRATOR);

    await setLeaveEntitlement(admin, { ...input, employeeId: "hr-admin-employee" }, stub.database);

    assert.equal(stub.records.size, 1);
    assert.equal(stub.audits[0]?.actorId, admin.id);
  });

  it("lists employee and leave-type choices only for HR or Super Administrators", async () => {
    const stub = createEntitlementDatabaseStub();
    assert.equal((await listLeaveEntitlementEmployees(hrAdmin, stub.database)).length, 1);
    assert.equal((await listLeaveTypesForEntitlements(hrAdmin, stub.database)).length, 1);
    await assert.rejects(listLeaveEntitlementEmployees(employee, stub.database), LeaveEntitlementAccessError);
    await assert.rejects(listLeaveTypesForEntitlements(employee, stub.database), LeaveEntitlementAccessError);
  });

  it("calculates HR balance from credits minus approved scheduled leave for the exact period", async () => {
    const stub = createEntitlementDatabaseStub();
    await setLeaveEntitlement(hrAdmin, input, stub.database);

    const result = await getManagedLeaveBalance(hrAdmin, input, stub.database);

    assert.equal(result.employee.id, input.employeeId);
    assert.equal(result.leaveType.id, input.leaveTypeId);
    assert.equal(result.balance?.approvedLeaveUsed?.toString(), "4");
    assert.equal(result.balance?.availableBalance?.toString(), "13.5");
    assert.equal(result.balance?.scheduleUnavailable, false);
  });

  it("does not deduct cancelled Leave requests", async () => {
    const usage = await calculateApprovedLeaveUsage({
      employeeId: "employee-1",
      leaveTypeId: "leave-type-1",
      periodStart: "2026-04-01",
      periodEnd: "2027-03-31",
      approvedLeaves: [{
        sourceId: "cancelled-request",
        employeeId: "employee-1",
        leaveTypeId: "leave-type-1",
        status: "CANCELLED",
        startDate: "2026-06-01",
        endDate: "2026-06-05",
      }],
    }, { database: {
      employee: { findUnique: async () => ({ id: "employee-1", userId: "employee-user", shift: { workingDays: [ShiftWeekday.MONDAY] } }) },
      leaveType: { findUnique: async () => ({ id: "leave-type-1" }) },
    } as never, resolveHolidayDates: async () => new Set<string>() });
    assert.equal(usage.toString(), "0");
  });

  it("flags scoped holidays that cannot be attributed to an employee", async () => {
    const stub = createEntitlementDatabaseStub();
    (stub.database as unknown as { holiday: { findMany: () => Promise<{ date: Date; branch: string; applicableEmployeeGroups: string[] }[]> } }).holiday.findMany = async () => [{
      date: new Date("2026-06-03T00:00:00.000Z"),
      branch: "Colombo",
      applicableEmployeeGroups: [],
    }];
    await setLeaveEntitlement(hrAdmin, input, stub.database);

    const result = await getManagedLeaveBalance(hrAdmin, input, stub.database);

    assert.equal(result.balance?.approvedLeaveUsed?.toString(), "5");
    assert.equal(result.balance?.scopedHolidaysUnresolved, true);
  });

  it("gets the entitlement for the exact Employee, Leave Type, and explicit period and keeps periods independent", async () => {
    const stub = createEntitlementDatabaseStub();
    await setLeaveEntitlement(admin, input, stub.database);
    await setLeaveEntitlement(admin, { ...input, leaveTypeId: "leave-type-2", entitlement: "9" }, stub.database);
    const nextPeriod = { ...input, periodStart: "2027-04-01", periodEnd: "2028-03-31", entitlement: "4" };
    await setLeaveEntitlement(admin, nextPeriod, stub.database);
    const database = stub.database;
    const saved = await getLeaveEntitlement(admin, input, database);
    const otherType = await getLeaveEntitlement(admin, { ...input, leaveTypeId: "leave-type-2" }, database);
    const otherPeriod = await getLeaveEntitlement(admin, nextPeriod, database);
    assert.equal(saved?.periodStart.toISOString().slice(0, 10), "2026-04-01");
    assert.equal(saved?.periodEnd.toISOString().slice(0, 10), "2027-03-31");
    assert.equal(saved?.entitlement.toString(), "14");
    assert.equal(otherType?.entitlement.toString(), "9");
    assert.equal(otherPeriod?.entitlement.toString(), "4");
    assert.equal(await getLeaveEntitlement(admin, { ...input, periodStart: "2025-04-01", periodEnd: "2026-03-31" }, database), null);
  });

  it("validates referenced Employee and Leave Type and audits balance changes without quantities", async () => {
    const stub = createEntitlementDatabaseStub();
    await assert.rejects(setLeaveEntitlement(admin, { ...input, employeeId: "missing" }, stub.database), LeaveEntitlementEmployeeNotFoundError);
    await assert.rejects(setLeaveEntitlement(admin, { ...input, leaveTypeId: "missing" }, stub.database), LeaveEntitlementTypeNotFoundError);
    await setLeaveEntitlement(admin, input, stub.database);
    await setLeaveEntitlement(admin, { ...input, entitlement: "16" }, stub.database);
    assert.equal(stub.records.size, 1);
    assert.equal(stub.audits.length, 2);
    assert.deepEqual(stub.audits[1]?.newValues, {
      employeeId: "employee-1",
      leaveEntitlementId: "entitlement-1",
      leaveTypeId: "leave-type-1",
      periodStart: "2026-04-01",
      periodEnd: "2027-03-31",
      changedFields: ["entitlement"],
    });
    assert.equal(JSON.stringify(stub.audits).includes("16"), false);
    assert.equal(stub.audits[0]?.actionType, "LEAVE_ENTITLEMENT_CREATED");
    assert.equal(stub.audits[1]?.actionType, "LEAVE_ENTITLEMENT_UPDATED");
    assert.equal(stub.audits[1]?.reason, input.reason);
  });
});

describe("Leave balance calculation", () => {
  it("shows employee self-service remaining balances calculated from approved scheduled Leave", async () => {
    const stub = createEntitlementDatabaseStub();
    await setLeaveEntitlement(admin, input, stub.database);

    const balances = await listOwnLeaveBalances(employee, stub.database);

    assert.equal(balances.length, 1);
    assert.equal(balances[0]?.balance.approvedLeaveUsed?.toString(), "4");
    assert.equal(balances[0]?.balance.availableBalance?.toString(), "13.5");
  });

  it("lists only the authenticated Employee's entitlement credits for periods active today", async () => {
    const stub = createOwnBalanceDatabaseStub();
    const result = await listOwnLeaveBalanceCredits(employee, stub.database);
    const where = (stub.calls.entitlements as { where: { periodStart: { lte: Date }; periodEnd: { gte: Date }; employeeId: string } }).where;
    const currentDate = new Date();
    const expectedAsOf = new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate()));

    assert.equal(result.length, 1);
    assert.equal(result[0]?.leaveType.name, "Annual");
    assert.deepEqual(stub.calls.employee, {
      where: { userId: employee.id },
      select: { id: true },
    });
    assert.equal(where.employeeId, "employee-1");
    assert.deepEqual(where.periodStart, { lte: expectedAsOf });
    assert.deepEqual(where.periodEnd, { gte: expectedAsOf });
    assert.deepEqual((stub.calls.entitlements as { orderBy: unknown }).orderBy, [
      { leaveType: { name: "asc" } },
      { periodStart: "asc" },
      { id: "asc" },
    ]);
  });

  it("returns no balance rows when the Employee has no active entitlement period", async () => {
    const stub = createOwnBalanceDatabaseStub(true, []);
    assert.deepEqual(await listOwnLeaveBalanceCredits(employee, stub.database), []);
  });

  it("rejects non-Employee and unauthenticated balance access before querying data", async () => {
    const stub = createOwnBalanceDatabaseStub();
    for (const actor of [
      null,
      { id: "admin-user", role: Role.ADMIN },
      { id: "hr-user", role: Role.HR_ADMINISTRATOR },
      { id: "manager-user", role: Role.DEPARTMENT_MANAGER },
      { id: "supervisor-user", role: Role.SUPERVISOR },
    ]) {
      await assert.rejects(listOwnLeaveBalanceCredits(actor, stub.database), LeaveBalanceAccessError);
    }
    assert.deepEqual(stub.calls, {});
  });

  it("reports an authenticated Employee without a linked employee record", async () => {
    const stub = createOwnBalanceDatabaseStub(false);
    await assert.rejects(
      listOwnLeaveBalanceCredits(employee, stub.database),
      LeaveEntitlementEmployeeNotFoundError,
    );
    assert.equal(stub.calls.entitlements, undefined);
  });

  it("calculates opening balance plus entitlement and carry-forward minus approved usage", () => {
    assert.equal(
      calculateAvailableLeaveBalance({
        openingBalance: "2",
        entitlement: "14",
        carryForward: "1.5",
      }, "3.25").toString(),
      "14.25",
    );
  });

  it("keeps zero entitlement and missing entitlement as zero credits", () => {
    assert.equal(calculateAvailableLeaveBalance({
      openingBalance: "0",
      entitlement: "0",
      carryForward: "0",
    }, "0").toString(), "0");
  });

  it("checks requested amounts precisely and rejects insufficient or non-positive requests", () => {
    assert.equal(assertLeaveBalanceCoversRequest("2.25", "2.25").toString(), "2.25");
    assert.throws(() => assertLeaveBalanceCoversRequest("2.24", "2.25"), InsufficientLeaveBalanceError);
    assert.throws(() => assertLeaveBalanceCoversRequest("2", "0"), { name: "ZodError" });
  });
});

describe("approved Leave usage", () => {
  function usageDatabase(workingDays: ShiftWeekday[] = [
    ShiftWeekday.MONDAY,
    ShiftWeekday.TUESDAY,
    ShiftWeekday.WEDNESDAY,
    ShiftWeekday.THURSDAY,
    ShiftWeekday.FRIDAY,
  ]) {
    return {
      employee: {
        findUnique: async ({ where }: { where: { id?: string; userId?: string } }) => where.id
          ? { id: where.id, userId: "employee-user" }
          : { id: "employee-1", userId: where.userId, shift: { workingDays } },
      },
      leaveType: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
    } as never;
  }

  it("deducts approved scheduled workdays once, ignoring duplicate, pending, and rejected entries", async () => {
    const approved = {
      sourceId: "request-1",
      employeeId: "employee-1",
      leaveTypeId: "leave-type-1",
      status: "APPROVED" as const,
      startDate: "2026-06-01",
      endDate: "2026-06-05",
    };
    const usage = await calculateApprovedLeaveUsage({
      employeeId: "employee-1",
      leaveTypeId: "leave-type-1",
      periodStart: "2026-04-01",
      periodEnd: "2027-03-31",
      approvedLeaves: [
        approved,
        approved,
        { ...approved, sourceId: "pending", status: "PENDING" },
        { ...approved, sourceId: "rejected", status: "REJECTED" },
      ],
    }, {
      database: usageDatabase(),
      resolveHolidayDates: async () => new Set(["2026-06-03"]),
    });
    assert.equal(usage.toString(), "4");
  });

  it("clips approved usage only to each supplied period and keeps explicit periods independent", async () => {
    const approvedLeaves = [
      { sourceId: "spring", employeeId: "employee-1", leaveTypeId: "leave-type-1", status: "APPROVED", startDate: "2026-03-30", endDate: "2026-04-03" },
      { sourceId: "autumn", employeeId: "employee-1", leaveTypeId: "leave-type-1", status: "APPROVED", startDate: "2026-09-29", endDate: "2026-10-02" },
      { sourceId: "other-type", employeeId: "employee-1", leaveTypeId: "leave-type-2", status: "APPROVED", startDate: "2026-04-01", endDate: "2026-04-02" },
    ];
    const dependencies = { database: usageDatabase(), resolveHolidayDates: async () => new Set<string>() };
    const firstPeriodUsage = await calculateApprovedLeaveUsage({
      employeeId: "employee-1",
      leaveTypeId: "leave-type-1",
      periodStart: "2026-04-01",
      periodEnd: "2026-09-30",
      approvedLeaves,
    }, dependencies);
    const secondPeriodUsage = await calculateApprovedLeaveUsage({
      employeeId: "employee-1",
      leaveTypeId: "leave-type-1",
      periodStart: "2026-10-01",
      periodEnd: "2027-03-31",
      approvedLeaves,
    }, dependencies);
    assert.equal(firstPeriodUsage.toString(), "5");
    assert.equal(secondPeriodUsage.toString(), "2");
  });

  it("rejects conflicting duplicate approval source IDs instead of double-counting", async () => {
    const record = {
      sourceId: "request-1",
      employeeId: "employee-1",
      leaveTypeId: "leave-type-1",
      status: "APPROVED" as const,
      startDate: "2026-06-01",
      endDate: "2026-06-01",
    };
    await assert.rejects(calculateApprovedLeaveUsage({
      employeeId: "employee-1",
      leaveTypeId: "leave-type-1",
      periodStart: "2026-04-01",
      periodEnd: "2027-03-31",
      approvedLeaves: [record, { ...record, endDate: "2026-06-02" }],
    }, { database: usageDatabase(), resolveHolidayDates: async () => new Set() }), LeaveUsageSourceConflictError);
  });

  it("rejects approved usage records belonging to another Employee", async () => {
    await assert.rejects(calculateApprovedLeaveUsage({
      employeeId: "employee-1",
      leaveTypeId: "leave-type-1",
      periodStart: "2026-04-01",
      periodEnd: "2027-03-31",
      approvedLeaves: [{
        sourceId: "request-1",
        employeeId: "employee-2",
        leaveTypeId: "leave-type-1",
        status: "APPROVED",
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      }],
    }, { database: usageDatabase(), resolveHolidayDates: async () => new Set() }), LeaveUsageEmployeeConflictError);
  });

  it("requires an existing linked Employee and Leave Type", async () => {
    await assert.rejects(calculateApprovedLeaveUsage({
      employeeId: "missing",
      leaveTypeId: "leave-type-1",
      periodStart: "2026-04-01",
      periodEnd: "2027-03-31",
      approvedLeaves: [],
    }, {
      database: {
        employee: { findUnique: async () => null },
        leaveType: { findUnique: async () => null },
      } as never,
      resolveHolidayDates: async () => new Set(),
    }), LeaveEntitlementEmployeeNotFoundError);
    await assert.rejects(calculateApprovedLeaveUsage({
      employeeId: "employee-1",
      leaveTypeId: "missing",
      periodStart: "2026-04-01",
      periodEnd: "2027-03-31",
      approvedLeaves: [],
    }, {
      database: {
        employee: { findUnique: async () => ({ id: "employee-1", userId: "employee-user" }) },
        leaveType: { findUnique: async () => null },
      } as never,
      resolveHolidayDates: async () => new Set(),
    }), LeaveEntitlementTypeNotFoundError);
  });
});
