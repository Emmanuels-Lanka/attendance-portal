import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma, Role } from "@prisma/client";
import type { ShiftWeekday } from "@prisma/client";
import {
  createShift,
  deleteShift,
  getChangedShiftFields,
  getShift,
  listShifts,
  listShiftOptions,
  ShiftAccessError,
  ShiftInUseError,
  ShiftNotFoundError,
  updateShift,
  writeShiftAuditEvent,
} from "@/lib/shifts/service";
import { shiftRecordSchema } from "@/lib/shifts/validation";

const admin = { role: Role.ADMIN };
const hrAdmin = { role: Role.HR_ADMINISTRATOR };
const employee = { role: Role.EMPLOYEE };

type Item = {
  id: string;
  name: string;
  startTime: Date | null;
  endTime: Date | null;
  breakStartTime: Date | null;
  breakDurationMinutes: number | null;
  gracePeriodMinutes: number | null;
  lateThresholdMinutes: number | null;
  earlyDepartureThresholdMinutes: number | null;
  minimumWorkingHours: number | null;
  overtimeEligible: boolean | null;
  roundingRules: unknown;
  workingDays: ShiftWeekday[];
  createdAt: Date;
  updatedAt: Date;
};

const emptyConfiguration = {
  startTime: null,
  endTime: null,
  breakStartTime: null,
  breakDurationMinutes: null,
  gracePeriodMinutes: null,
  lateThresholdMinutes: null,
  earlyDepartureThresholdMinutes: null,
  minimumWorkingHours: null,
  overtimeEligible: null,
  roundingRules: null,
};

function createDatabaseStub() {
  const records = new Map<string, Item>([
    ["shift-1", { id: "shift-1", name: "Day", ...emptyConfiguration, workingDays: [], createdAt: new Date(0), updatedAt: new Date(0) }],
    ["shift-2", { id: "shift-2", name: "Night", ...emptyConfiguration, workingDays: [], createdAt: new Date(0), updatedAt: new Date(0) }],
  ]);
  const assignedIds = new Set(["shift-2"]);
  const attendanceIds = new Set<string>();
  const calls: string[] = [];
  const resultItem = (item: Item) => ({ ...item });
  const database = {
    shift: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        calls.push("shift.findUnique");
        const item = records.get(where.id);
        return item ? resultItem(item) : null;
      },
      findMany: async ({ where, skip, take }: {
        where?: { name?: { contains?: string } };
        skip?: number;
        take?: number;
      }) => {
        calls.push("shift.findMany");
        const query = where?.name?.contains?.toLowerCase();
        const matched = [...records.values()]
          .filter((item) => !query || item.name.toLowerCase().includes(query))
          .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
        return matched.slice(skip ?? 0, (skip ?? 0) + (take ?? matched.length)).map(resultItem);
      },
      count: async ({ where }: { where?: { name?: { contains?: string } } } = {}) => {
        calls.push("shift.count");
        const query = where?.name?.contains?.toLowerCase();
        return [...records.values()].filter((item) => !query || item.name.toLowerCase().includes(query)).length;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push("shift.create");
        const now = new Date();
        const item = {
          id: "shift-3",
          ...emptyConfiguration,
          ...data,
          roundingRules: data.roundingRules === Prisma.DbNull ? null : data.roundingRules,
          createdAt: now,
          updatedAt: now,
        } as Item;
        records.set(item.id, item);
        return resultItem(item);
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.push("shift.update");
        const current = records.get(where.id);
        if (!current) throw { code: "P2025" };
        const item = {
          ...current,
          ...data,
          roundingRules: data.roundingRules === Prisma.DbNull ? null : data.roundingRules,
          updatedAt: new Date(),
        } as Item;
        records.set(where.id, item);
        return resultItem(item);
      },
      delete: async ({ where }: { where: { id: string } }) => {
        calls.push("shift.delete");
        const current = records.get(where.id);
        if (!current) throw { code: "P2025" };
        records.delete(where.id);
        return { id: current.id, name: current.name };
      },
    },
    employee: {
      count: async ({ where }: { where: { shiftId: string } }) => {
        calls.push("employee.count");
        return assignedIds.has(where.shiftId) ? 1 : 0;
      },
    },
    attendanceDaily: {
      count: async ({ where }: { where: { shiftId: string } }) => {
        calls.push("attendanceDaily.count");
        return attendanceIds.has(where.shiftId) ? 1 : 0;
      },
    },
  } as never;
  return { database, calls, records, attendanceIds };
}

describe("shift validation", () => {
  it("trims the name, defaults optional settings to null, and rejects invalid names or duplicate days", () => {
    assert.deepEqual(shiftRecordSchema.parse({ name: "  Day  " }), {
      name: "Day",
      ...emptyConfiguration,
      workingDays: [],
    });
    assert.equal(shiftRecordSchema.safeParse({ name: "" }).success, false);
    assert.equal(shiftRecordSchema.safeParse({ name: "   " }).success, false);
    assert.equal(shiftRecordSchema.safeParse({ name: "Day", workingDays: ["MONDAY", "MONDAY"] }).success, false);
  });

  it("parses configured values without assigning policy defaults", () => {
    const parsed = shiftRecordSchema.parse({
      name: " Day ",
      startTime: "08:30",
      endTime: "17:30",
      breakDurationMinutes: "30",
      gracePeriodMinutes: "5",
      lateThresholdMinutes: "10",
      earlyDepartureThresholdMinutes: "15",
      minimumWorkingHours: "7.5",
      overtimeEligible: "false",
      roundingRules: '{"unit":"quarter-hour"}',
      workingDays: ["MONDAY", "FRIDAY"],
    });
    assert.equal(parsed.startTime?.toISOString(), "1970-01-01T08:30:00.000Z");
    assert.equal(parsed.endTime?.toISOString(), "1970-01-01T17:30:00.000Z");
    assert.deepEqual({
      break: parsed.breakDurationMinutes,
      grace: parsed.gracePeriodMinutes,
      late: parsed.lateThresholdMinutes,
      early: parsed.earlyDepartureThresholdMinutes,
      hours: parsed.minimumWorkingHours,
      overtime: parsed.overtimeEligible,
      rounding: parsed.roundingRules,
      days: parsed.workingDays,
    }, {
      break: 30,
      grace: 5,
      late: 10,
      early: 15,
      hours: 7.5,
      overtime: false,
      rounding: { unit: "quarter-hour" },
      days: ["MONDAY", "FRIDAY"],
    });
    const unboundedSettings = shiftRecordSchema.parse({
      name: "Unbounded values",
      breakDurationMinutes: "-10",
      minimumWorkingHours: "-0.5",
    });
    assert.equal(unboundedSettings.breakDurationMinutes, -10);
    assert.equal(unboundedSettings.minimumWorkingHours, -0.5);
  });

  it("rejects invalid time, field precision, boolean, and JSON inputs", () => {
    const invalidRecords = [
      { startTime: "25:00" },
      { breakDurationMinutes: "1.5" },
      { gracePeriodMinutes: "1.5" },
      { minimumWorkingHours: "7.555" },
      { overtimeEligible: "yes" },
      { roundingRules: "{not json}" },
    ];
    for (const invalid of invalidRecords) {
      assert.equal(shiftRecordSchema.safeParse({ name: "Day", ...invalid }).success, false);
    }
  });

  it("accepts break timing only when its duration and interval fit inside the shift", () => {
    const valid = shiftRecordSchema.parse({
      name: "Day",
      startTime: "08:00",
      endTime: "17:30",
      breakStartTime: "12:00",
      breakDurationMinutes: "60",
    });
    assert.equal(valid.breakStartTime?.toISOString(), "1970-01-01T12:00:00.000Z");
    assert.equal(shiftRecordSchema.safeParse({
      name: "Day",
      startTime: "08:00",
      endTime: "17:30",
      breakStartTime: "17:00",
      breakDurationMinutes: "60",
    }).success, false);
  });

  it("rejects invalid Shift names before database access", async () => {
    const stub = createDatabaseStub();
    await assert.rejects(createShift(admin, { name: " " }, stub.database), { name: "ZodError" });
    await assert.rejects(updateShift(admin, "shift-1", { name: "" }, stub.database), { name: "ZodError" });
    assert.deepEqual(stub.calls, []);
  });
});

describe("shift management", () => {
  it("allows HR to list, create, read, update, and delete shifts", async () => {
    const stub = createDatabaseStub();
    const options = await listShiftOptions(hrAdmin, stub.database);
    assert.deepEqual(options.map(({ id, name }) => ({ id, name })), [
      { id: "shift-1", name: "Day" },
      { id: "shift-2", name: "Night" },
    ]);
    const listed = await listShifts(hrAdmin, {}, stub.database);
    assert.equal(listed.total, 2);

    const created = await createShift(hrAdmin, { name: "HR-created", workingDays: ["MONDAY"] }, stub.database);
    assert.equal((await getShift(hrAdmin, created.id, stub.database)).name, "HR-created");
    const updated = await updateShift(hrAdmin, created.id, { name: "HR-updated", workingDays: ["TUESDAY"] }, stub.database);
    assert.equal(updated.name, "HR-updated");
    assert.deepEqual(updated.workingDays, ["TUESDAY"]);
    assert.deepEqual(await deleteShift(hrAdmin, created.id, stub.database), { id: created.id, name: "HR-updated" });
  });

  it("rejects users without shift management permission before database access", async () => {
    const stub = createDatabaseStub();
    await assert.rejects(listShiftOptions(employee, stub.database), ShiftAccessError);
    await assert.rejects(listShifts(employee, {}, stub.database), ShiftAccessError);
    await assert.rejects(getShift(employee, "shift-1", stub.database), ShiftAccessError);
    await assert.rejects(createShift(employee, { name: "Day" }, stub.database), ShiftAccessError);
    await assert.rejects(updateShift(employee, "shift-1", { name: "Day" }, stub.database), ShiftAccessError);
    await assert.rejects(deleteShift(employee, "shift-1", stub.database), ShiftAccessError);
    assert.deepEqual(stub.calls, []);
  });

  it("creates and reads a Shift configuration", async () => {
    const stub = createDatabaseStub();
    const created = await createShift(admin, {
      name: "  Evening ",
      startTime: "14:00",
      endTime: "22:00",
      breakDurationMinutes: "30",
      gracePeriodMinutes: "5",
      lateThresholdMinutes: "10",
      earlyDepartureThresholdMinutes: "15",
      minimumWorkingHours: "7.5",
      overtimeEligible: "true",
      roundingRules: '{"increment":15}',
      workingDays: ["TUESDAY", "SATURDAY"],
    }, stub.database);
    assert.equal(created.name, "Evening");
    assert.equal(created.startTime?.toISOString(), "1970-01-01T14:00:00.000Z");
    assert.equal(created.minimumWorkingHours, 7.5);
    assert.equal(created.overtimeEligible, true);
    assert.deepEqual(created.roundingRules, { increment: 15 });
    assert.deepEqual(created.workingDays, ["TUESDAY", "SATURDAY"]);
    assert.equal((await getShift(admin, created.id, stub.database)).breakDurationMinutes, 30);
    assert.equal((await getShift(admin, "shift-1", stub.database)).name, "Day");
    await assert.rejects(getShift(admin, "missing", stub.database), ShiftNotFoundError);
  });

  it("searches, sorts, paginates, and counts Shifts", async () => {
    const stub = createDatabaseStub();
    const result = await listShifts(admin, { query: "day", page: 1, pageSize: 1 }, stub.database);
    assert.equal(result.total, 1);
    assert.equal(result.items[0]?.name, "Day");
    assert.equal(result.pageCount, 1);
    const secondPage = await listShifts(admin, { page: 2, pageSize: 1 }, stub.database);
    assert.equal(secondPage.items[0]?.name, "Night");
  });

  it("updates configuration and identifies only changed fields", async () => {
    const stub = createDatabaseStub();
    const before = await getShift(admin, "shift-1", stub.database);
    const updated = await updateShift(admin, "shift-1", {
      name: "Daytime",
      startTime: "08:30",
      endTime: "16:30",
      minimumWorkingHours: "7.5",
      overtimeEligible: "false",
      roundingRules: "",
      workingDays: ["WEDNESDAY"],
    }, stub.database);
    assert.equal(updated.name, "Daytime");
    assert.equal(updated.startTime?.toISOString(), "1970-01-01T08:30:00.000Z");
    assert.equal(updated.minimumWorkingHours, 7.5);
    assert.equal(updated.overtimeEligible, false);
    assert.deepEqual(updated.workingDays, ["WEDNESDAY"]);
    assert.deepEqual(getChangedShiftFields(before, updated), [
      "name",
      "startTime",
      "endTime",
      "minimumWorkingHours",
      "overtimeEligible",
      "workingDays",
    ]);
  });

  it("blocks deletion while employees or attendance rows reference a shift", async () => {
    const stub = createDatabaseStub();
    await assert.rejects(deleteShift(admin, "shift-2", stub.database), ShiftInUseError);
    stub.attendanceIds.add("shift-1");
    await assert.rejects(deleteShift(admin, "shift-1", stub.database), ShiftInUseError);
    stub.attendanceIds.clear();
    assert.deepEqual(await deleteShift(admin, "shift-1", stub.database), { id: "shift-1", name: "Day" });
    await assert.rejects(deleteShift(admin, "missing", stub.database), ShiftNotFoundError);
  });

  it("writes privacy-conscious create, update, and delete audit events", async () => {
    const entries: Record<string, unknown>[] = [];
    const database = {
      attendanceAuditLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          entries.push(data);
          return { id: `audit-${entries.length}` };
        },
      },
    } as never;
    for (const operation of ["CREATED", "UPDATED", "DELETED"] as const) {
      await writeShiftAuditEvent(database, { shiftId: "shift-1", actorId: "admin-1", operation });
    }
    await writeShiftAuditEvent(database, { shiftId: "shift-1", actorId: "admin-1", operation: "UPDATED", changedFields: ["workingDays"] });
    assert.deepEqual(entries.map((entry) => entry.actionType), ["SHIFT_CREATED", "SHIFT_UPDATED", "SHIFT_DELETED", "SHIFT_UPDATED"]);
    assert.deepEqual(entries[1]?.previousValues, { shiftId: "shift-1", changedFields: ["name"] });
    assert.deepEqual(entries[1]?.newValues, { shiftId: "shift-1", changedFields: ["name"] });
    assert.deepEqual(entries[2]?.previousValues, { shiftId: "shift-1", changedFields: ["id"] });
    assert.equal("newValues" in (entries[2] ?? {}), false);
    assert.deepEqual(entries[3]?.newValues, { shiftId: "shift-1", changedFields: ["workingDays"] });
    assert.match(String(entries[0]?.reason), /authorized administrator/);
  });
});
