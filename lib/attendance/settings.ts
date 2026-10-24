import "server-only";

import type { PrismaClient, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isIanaTimeZone } from "@/lib/attendance/timezone";

const settingDefaults = { companyName: "Emmanuel's Lanka Pvt Ltd", defaultTimeZone: "Asia/Colombo" } as const;
type EditableSettingKey = keyof typeof settingDefaults;
type SettingActor = { id: string; role: Role };
type SettingDatabase = Pick<PrismaClient, "$transaction">;
type CompanyNameDatabase = Pick<PrismaClient, "appSetting">;

export class SettingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingValidationError";
  }
}

export class SettingAuthorizationError extends Error {
  constructor() {
    super("Administrator access is required to change organization settings.");
    this.name = "SettingAuthorizationError";
  }
}

function editableKey(value: string): value is EditableSettingKey {
  return Object.hasOwn(settingDefaults, value);
}

export async function getCompanyName(database: CompanyNameDatabase = prisma) {
  const setting = await database.appSetting.findUnique({
    where: { key: "companyName" },
    select: { value: true },
  });
  return setting?.value.trim() || settingDefaults.companyName;
}

export async function getDefaultTimeZone(database: CompanyNameDatabase = prisma) {
  const setting = await database.appSetting.findUnique({
    where: { key: "defaultTimeZone" },
    select: { value: true },
  });
  const timeZone = setting?.value.trim() || settingDefaults.defaultTimeZone;
  if (!isIanaTimeZone(timeZone)) throw new SettingValidationError("Use a valid IANA timezone.");
  return timeZone;
}

export async function updateOrganizationSetting(
  actor: SettingActor,
  input: { key: string; value?: string; intent?: string; confirmReset?: boolean },
  database: SettingDatabase = prisma,
) {
  if (actor.role !== "ADMIN") throw new SettingAuthorizationError();
  if (!editableKey(input.key)) throw new SettingValidationError("This setting cannot be changed here.");
  const intent = input.intent ?? "save";
  if (intent !== "save" && intent !== "reset") throw new SettingValidationError("Invalid setting action.");
  if (intent === "reset" && !input.confirmReset) throw new SettingValidationError("Confirm the setting reset.");

  const key = input.key;
  const value = intent === "reset" ? settingDefaults[key] : input.value?.trim() ?? "";
  if (!value || value.length > 120) throw new SettingValidationError("Enter a setting value between 1 and 120 characters.");
  if (key === "defaultTimeZone" && !isIanaTimeZone(value)) throw new SettingValidationError("Use a valid IANA timezone.");

  return database.$transaction(async (tx) => {
    const previous = await tx.appSetting.findUnique({ where: { key }, select: { value: true } });
    const setting = await tx.appSetting.upsert({
      where: { key },
      update: {
        value,
        category: key === "defaultTimeZone" ? "ATTENDANCE" : "GENERAL",
        isAdminOnly: true,
        updatedById: actor.id,
      },
      create: {
        key,
        value,
        category: key === "defaultTimeZone" ? "ATTENDANCE" : "GENERAL",
        isAdminOnly: true,
        updatedById: actor.id,
      },
    });

    if (previous?.value !== value) {
      await tx.attendanceAuditLog.create({
        data: {
          actorId: actor.id,
          actionType: intent === "reset" ? "SETTING_RESET" : "SETTING_UPDATED",
          settingKey: key,
          previousValues: { value: previous?.value ?? null },
          newValues: { value },
          reason: intent === "reset" ? "Administrator reset the setting to its documented default." : "Administrator updated an organization setting.",
        },
      });
    }
    return setting;
  });
}