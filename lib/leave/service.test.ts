import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role } from "@prisma/client";
import {
  createLeaveType,
  deleteLeaveType,
  getLeaveType,
  LeaveTypeAccessError,
  LeaveTypeInUseError,
  LeaveTypeNotFoundError,
  listLeaveTypes,
  updateLeaveType,
  writeLeaveTypeAuditEvent,
} from "@/lib/leave/service";
import { leaveTypeRecordSchema } from "@/lib/leave/validation";

const admin = { role: Role.ADMIN };
const employee = { role: Role.EMPLOYEE };

type Item = { id: string; name: string; createdAt: Date; updatedAt: Date };

function createDatabaseStub() {
  const records = new Map<string, Item>([
    ["type-1", { id: "type-1", name: "Annual", createdAt: new Date(0), updatedAt: new Date(0) }],
    ["type-2", { id: "type-2", name: "Medical", createdAt: new Date(0), updatedAt: new Date(0) }],
    ["type-3", { id: "type-3", name: "Annual", createdAt: new Date(0), updatedAt: new Date(0) }],
  ]);
  const calls: string[] = [];
  const database = {
    leaveType: {
      findMany: async ({ where, skip, take }: { where?: { name?: { contains?: string } }; skip?: number; take?: number }) => {
        calls.push("findMany");
        const query = where?.name?.contains?.toLowerCase();
        const matched = [...records.values()]
          .filter((record) => !query || record.name.toLowerCase().includes(query))
          .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
        return matched.slice(skip ?? 0, (skip ?? 0) + (take ?? matched.length));
      },
      count: async ({ where }: { where?: { name?: { contains?: string } } }) => {
        calls.push("count");
        const query = where?.name?.contains?.toLowerCase();
        return [...records.values()].filter((record) => !query || record.name.toLowerCase().includes(query)).length;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        calls.push("findUnique");
        return records.get(where.id) ?? null;
      },
      create: async ({ data }: { data: { name: string } }) => {
        calls.push("create");
        const now = new Date();
        const item = { id: "type-new", name: data.name, createdAt: now, updatedAt: now };
        records.set(item.id, item);
        return { id: item.id, name: item.name };
      },
      update: async ({ where, data }: { where: { id: string }; data: { name: string } }) => {
        calls.push("update");
        const item = records.get(where.id);
        if (!item) throw { code: "P2025" };
        records.set(where.id, { ...item, name: data.name, updatedAt: new Date() });
        return { id: where.id, name: data.name };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        calls.push("delete");
        const item = records.get(where.id);
        if (!item) throw { code: "P2025" };
        records.delete(where.id);
        return { id: item.id, name: item.name };
      },
    },
  } as never;
  return { database, records, calls };
}

describe("Leave Type validation", () => {
  it("trims names, rejects blank values, and applies the master-data length limit", () => {
    assert.equal(leaveTypeRecordSchema.parse({ name: "  Annual  " }).name, "Annual");
    assert.equal(leaveTypeRecordSchema.safeParse({ name: "" }).success, false);
    assert.equal(leaveTypeRecordSchema.safeParse({ name: "   " }).success, false);
    assert.equal(leaveTypeRecordSchema.safeParse({ name: "x".repeat(121) }).success, false);
  });

  it("rejects blank names on create and update before accessing storage", async () => {
    const stub = createDatabaseStub();
    await assert.rejects(createLeaveType(admin, { name: " " }, stub.database), { name: "ZodError" });
    await assert.rejects(updateLeaveType(admin, "type-1", { name: "" }, stub.database), { name: "ZodError" });
    assert.deepEqual(stub.calls, []);
  });
});

describe("Leave Type management", () => {
  it("requires ADMIN for list, get, create, update, and delete", async () => {
    const stub = createDatabaseStub();
    await assert.rejects(listLeaveTypes(employee, {}, stub.database), LeaveTypeAccessError);
    await assert.rejects(getLeaveType(employee, "type-1", stub.database), LeaveTypeAccessError);
    await assert.rejects(createLeaveType(employee, { name: "Personal" }, stub.database), LeaveTypeAccessError);
    await assert.rejects(updateLeaveType(employee, "type-1", { name: "Other" }, stub.database), LeaveTypeAccessError);
    await assert.rejects(deleteLeaveType(employee, "type-1", stub.database), LeaveTypeAccessError);
    assert.deepEqual(stub.calls, []);
  });

  it("creates a trimmed Leave Type", async () => {
    const stub = createDatabaseStub();
    assert.deepEqual(await createLeaveType(admin, { name: "  Personal  " }, stub.database), {
      id: "type-new",
      name: "Personal",
    });
  });

  it("gets records and reports a missing ID", async () => {
    const stub = createDatabaseStub();
    assert.equal((await getLeaveType(admin, "type-1", stub.database)).name, "Annual");
    await assert.rejects(getLeaveType(admin, "missing", stub.database), LeaveTypeNotFoundError);
  });

  it("searches and paginates records with stable ordering", async () => {
    const stub = createDatabaseStub();
    const search = await listLeaveTypes(admin, { query: "annual", page: 1, pageSize: 1 }, stub.database);
    assert.equal(search.total, 2);
    assert.equal(search.pageCount, 2);
    assert.equal(search.items[0]?.id, "type-1");
    const secondPage = await listLeaveTypes(admin, { query: "annual", page: 2, pageSize: 1 }, stub.database);
    assert.equal(secondPage.items[0]?.id, "type-3");
  });

  it("allows duplicate names, matching existing master-data conventions", async () => {
    const stub = createDatabaseStub();
    const created = await createLeaveType(admin, { name: "Annual" }, stub.database);
    assert.equal(created.name, "Annual");
  });

  it("updates a Leave Type and translates missing records", async () => {
    const stub = createDatabaseStub();
    assert.deepEqual(await updateLeaveType(admin, "type-1", { name: "Annual Leave" }, stub.database), {
      id: "type-1",
      name: "Annual Leave",
    });
    await assert.rejects(updateLeaveType(admin, "missing", { name: "Missing" }, stub.database), LeaveTypeNotFoundError);
  });

  it("deletes existing records, translates missing records, and prevents future restricted references", async () => {
    const stub = createDatabaseStub();
    assert.deepEqual(await deleteLeaveType(admin, "type-2", stub.database), { id: "type-2", name: "Medical" });
    await assert.rejects(deleteLeaveType(admin, "missing", stub.database), LeaveTypeNotFoundError);
    const restrictedDatabase = {
      leaveType: { delete: async () => { throw { code: "P2003" }; } },
    } as never;
    await assert.rejects(deleteLeaveType(admin, "referenced", restrictedDatabase), LeaveTypeInUseError);
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
      await writeLeaveTypeAuditEvent(database, { leaveTypeId: "type-1", actorId: "admin-1", operation });
    }
    assert.deepEqual(entries.map((entry) => entry.actionType), [
      "LEAVE_TYPE_CREATED",
      "LEAVE_TYPE_UPDATED",
      "LEAVE_TYPE_DELETED",
    ]);
    assert.deepEqual(entries[1]?.previousValues, { leaveTypeId: "type-1", changedFields: ["name", "durationMode"] });
    assert.deepEqual(entries[1]?.newValues, { leaveTypeId: "type-1", changedFields: ["name", "durationMode"] });
    assert.deepEqual(entries[2]?.previousValues, { leaveTypeId: "type-1", changedFields: ["id"] });
    assert.equal("newValues" in (entries[2] ?? {}), false);
  });
});
