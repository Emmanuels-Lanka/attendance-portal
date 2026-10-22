import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role } from "@prisma/client";
import { getCompanyName, SettingAuthorizationError, SettingValidationError, updateOrganizationSetting } from "./settings";

function createDatabase(initialValue = "Asia/Colombo") {
  const settings = new Map<string, { key: string; value: string; category: string; isAdminOnly: boolean; updatedById: string }>([
    ["defaultTimeZone", { key: "defaultTimeZone", value: initialValue, category: "ATTENDANCE", isAdminOnly: true, updatedById: "admin-1" }],
  ]);
  const auditEntries: Array<{ actionType: string; settingKey: string | null; previousValues: unknown; newValues: unknown }> = [];
  let transactionCount = 0;
  const database = {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => settings.get(where.key) ?? null,
    },
    $transaction: async (operation: (tx: never) => Promise<unknown>) => {
      transactionCount += 1;
      const tx = {
        appSetting: {
          findUnique: async ({ where }: { where: { key: string } }) => settings.get(where.key) ?? null,
          upsert: async ({ where, update, create }: { where: { key: string }; update: typeof settings extends Map<string, infer T> ? T : never; create: typeof settings extends Map<string, infer T> ? T : never }) => {
            const existing = settings.get(where.key);
            const next = { ...(existing ?? create), ...update };
            settings.set(where.key, next);
            return next;
          },
        },
        attendanceAuditLog: {
          create: async ({ data }: { data: { actionType: string; settingKey: string | null; previousValues: unknown; newValues: unknown } }) => {
            auditEntries.push(data);
            return data;
          },
        },
      };
      return operation(tx as never);
    },
  };
  return { database: database as never, settings, auditEntries, getTransactionCount: () => transactionCount };
}

const admin = { id: "admin-1", role: Role.ADMIN };

describe("organization setting controls", () => {
  it("uses the saved company name and falls back to the documented default", async () => {
    const stub = createDatabase();
    assert.equal(await getCompanyName(stub.database), "Emmanuel's Lanka Pvt Ltd");
    stub.settings.set("companyName", {
      key: "companyName",
      value: "Example Company",
      category: "GENERAL",
      isAdminOnly: true,
      updatedById: "admin-1",
    });
    assert.equal(await getCompanyName(stub.database), "Example Company");
    stub.settings.set("companyName", {
      key: "companyName",
      value: "  ",
      category: "GENERAL",
      isAdminOnly: true,
      updatedById: "admin-1",
    });
    assert.equal(await getCompanyName(stub.database), "Emmanuel's Lanka Pvt Ltd");
  });

  it("rejects invalid timezones and unsupported setting keys before writing", async () => {
    const stub = createDatabase();
    await assert.rejects(updateOrganizationSetting(admin, { key: "defaultTimeZone", value: "Mars/Olympus" }, stub.database), SettingValidationError);
    await assert.rejects(updateOrganizationSetting(admin, { key: "attendanceStart", value: "09:00" }, stub.database), SettingValidationError);
    assert.equal(stub.getTransactionCount(), 0);
  });

  it("rejects non-admin setting changes before writing", async () => {
    const stub = createDatabase();
    await assert.rejects(updateOrganizationSetting({ id: "employee-1", role: Role.EMPLOYEE }, { key: "companyName", value: "Other" }, stub.database), SettingAuthorizationError);
    await assert.rejects(updateOrganizationSetting({ id: "hr-1", role: Role.HR_ADMINISTRATOR }, { key: "companyName", value: "Other" }, stub.database), SettingAuthorizationError);
    assert.equal(stub.getTransactionCount(), 0);
  });

  it("records setting changes and requires confirmation before resetting defaults", async () => {
    const stub = createDatabase();
    await updateOrganizationSetting(admin, { key: "defaultTimeZone", value: "Asia/Dhaka" }, stub.database);
    assert.equal(stub.settings.get("defaultTimeZone")?.value, "Asia/Dhaka");
    assert.equal(stub.auditEntries[0].actionType, "SETTING_UPDATED");
    assert.deepEqual(stub.auditEntries[0].previousValues, { value: "Asia/Colombo" });
    assert.deepEqual(stub.auditEntries[0].newValues, { value: "Asia/Dhaka" });

    await assert.rejects(updateOrganizationSetting(admin, { key: "defaultTimeZone", intent: "reset" }, stub.database), /Confirm/);
    await updateOrganizationSetting(admin, { key: "defaultTimeZone", intent: "reset", confirmReset: true }, stub.database);
    assert.equal(stub.settings.get("defaultTimeZone")?.value, "Asia/Colombo");
    assert.equal(stub.auditEntries[1].actionType, "SETTING_RESET");
  });

  it("resets the stored company name to the approved default", async () => {
    const stub = createDatabase();
    stub.settings.set("companyName", {
      key: "companyName",
      value: "Legacy Company Name",
      category: "GENERAL",
      isAdminOnly: true,
      updatedById: "admin-1",
    });

    await updateOrganizationSetting(admin, {
      key: "companyName",
      intent: "reset",
      confirmReset: true,
    }, stub.database);

    assert.equal(stub.settings.get("companyName")?.value, "Emmanuel's Lanka Pvt Ltd");
    assert.deepEqual(stub.auditEntries[0].newValues, { value: "Emmanuel's Lanka Pvt Ltd" });
  });
});