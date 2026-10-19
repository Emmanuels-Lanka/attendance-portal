/* eslint-disable @typescript-eslint/no-explicit-any */

import { formatInTimeZone } from "date-fns-tz";
import { prisma } from "@/lib/prisma";

export type AttendanceMode = "OFFICE" | "WFH";

export type MonthlySessionLike = {
  id: string;
  mode: AttendanceMode;
  startAt: Date;
  endAt: Date | null;
};

export type MonthlyReportEmployee = {
  id: string;
  name: string;
  email?: string;
  timeZone: string;
};

export type EmployeeMonthlyReport = {
  monthLabel: string;
  empty: boolean;
  summary: {
    totalSessions: number;
    completedSessions: number;
    activeSessions: number;
    totalWorkedMs: number;
  };
  days: Array<{
    date: string;
    sessions: Array<{
      id: string;
      mode: AttendanceMode;
      startAt: Date;
      endAt: Date | null;
    }>;
    totalWorkedMs: number;
  }>;
};

export function getSettingsSnapshot(values: Partial<Record<string, string | string[] | boolean>> = {}) {
  const companyName = typeof values.companyName === "string" && values.companyName.trim() ? values.companyName.trim() : "Emmanuel's Lanka Pvt Ltd";
  const attendanceStart = typeof values.attendanceStart === "string" && values.attendanceStart.trim() ? values.attendanceStart.trim() : "08:30";
  const attendanceEnd = typeof values.attendanceEnd === "string" && values.attendanceEnd.trim() ? values.attendanceEnd.trim() : "17:30";
  const defaultTimeZone = typeof values.defaultTimeZone === "string" && values.defaultTimeZone.trim() ? values.defaultTimeZone.trim() : "Asia/Colombo";
  const supportedTimeZones = Array.isArray(values.supportedTimeZones) && values.supportedTimeZones.length > 0
    ? values.supportedTimeZones.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : ["Asia/Colombo", "Asia/Dhaka"];

  return {
    companyName,
    attendanceSchedule: { start: attendanceStart, end: attendanceEnd },
    defaultTimeZone,
    supportedTimeZones,
  };
}

export function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function buildMonthlyEmployeeReport(
  employee: MonthlyReportEmployee,
  month: string,
  sessions: MonthlySessionLike[],
): EmployeeMonthlyReport {
  const safeMonth = month.trim();
  const monthLabel = safeMonth || "2026-01";
  const dayMap = new Map<string, { date: string; sessions: MonthlySessionLike[]; totalWorkedMs: number }>();

  let totalSessions = 0;
  let completedSessions = 0;
  let activeSessions = 0;
  let totalWorkedMs = 0;

  for (const session of sessions) {
    if (!session || !session.id) continue;
    totalSessions += 1;
    if (!session.endAt) {
      activeSessions += 1;
      continue;
    }
    if (Number.isFinite(session.startAt.getTime()) && Number.isFinite(session.endAt.getTime()) && session.endAt >= session.startAt) {
      completedSessions += 1;
      totalWorkedMs += session.endAt.getTime() - session.startAt.getTime();
    }

    const date = formatInTimeZone(session.startAt, employee.timeZone, "yyyy-MM-dd");
    const entry = dayMap.get(date) ?? { date, sessions: [], totalWorkedMs: 0 };
    entry.sessions.push(session);
    if (session.endAt && session.endAt >= session.startAt) {
      entry.totalWorkedMs += session.endAt.getTime() - session.startAt.getTime();
    }
    dayMap.set(date, entry);
  }

  const days = [...dayMap.values()].sort((left, right) => right.date.localeCompare(left.date)).map((day) => ({
    date: day.date,
    sessions: day.sessions,
    totalWorkedMs: day.totalWorkedMs,
  }));

  return {
    monthLabel,
    empty: days.length === 0 && totalSessions === 0,
    summary: {
      totalSessions,
      completedSessions,
      activeSessions,
      totalWorkedMs,
    },
    days,
  };
}

export async function createNotification({
  userId,
  title,
  message,
  type,
  database = prisma as any,
}: {
  userId: string;
  title: string;
  message: string;
  type: string;
  database?: any;
}) {
  const trimmedTitle = title?.trim();
  const trimmedMessage = message?.trim();
  if (!trimmedTitle || !trimmedMessage) {
    throw new Error("Notification title and message are required.");
  }

  if (Array.isArray(database?.notifications)) {
    const duplicate = database.notifications.find(
      (item: any) => item.userId === userId && item.title === trimmedTitle && item.message === trimmedMessage && item.type === type,
    );
    if (duplicate) {
      return { duplicate: true, notification: duplicate };
    }
    const notification = {
      id: `notification-${Date.now()}`,
      userId,
      title: trimmedTitle,
      message: trimmedMessage,
      type,
      readAt: null,
      createdAt: new Date(),
    };
    database.notifications.push(notification);
    return { duplicate: false, notification };
  }

  const duplicate = await database.notification?.findFirst?.({
    where: { userId, title: trimmedTitle, message: trimmedMessage, type },
  });
  if (duplicate) {
    return { duplicate: true, notification: duplicate };
  }

  const notification = await database.notification.create({
    data: { userId, title: trimmedTitle, message: trimmedMessage, type },
  });
  return { duplicate: false, notification };
}

export async function getUnreadNotificationCount(userId: string, database: any = prisma) {
  if (Array.isArray(database?.notifications)) {
    return database.notifications.filter((notification: any) => notification.userId === userId && notification.readAt === null).length;
  }

  return database.notification.count({
    where: { userId, readAt: null },
  });
}

export async function listUserNotifications(userId: string, database: any = prisma) {
  if (Array.isArray(database?.notifications)) {
    return database.notifications.filter((notification: any) => notification.userId === userId).sort((left: any, right: any) => Number(new Date(right.createdAt)) - Number(new Date(left.createdAt)));
  }

  return database.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

export async function markNotificationRead(notificationId: string, database: any = prisma) {
  if (Array.isArray(database?.notifications)) {
    const notification = database.notifications.find((item: any) => item.id === notificationId);
    if (!notification) return null;
    notification.readAt = new Date();
    return notification;
  }

  return database.notification.update({
    where: { id: notificationId },
    data: { readAt: new Date() },
  });
}

export async function readAppSettings(database: any = prisma) {
  const rows = Array.isArray(database?.appSettings)
    ? database.appSettings
    : await database.appSetting.findMany({
        orderBy: { key: "asc" },
      });

  const map = new Map<string, string>();
  for (const row of rows) {
    if (row && typeof row.key === "string") {
      map.set(row.key, String(row.value ?? ""));
    }
  }

  const settings = getSettingsSnapshot({
    companyName: map.get("companyName") ?? undefined,
    attendanceStart: map.get("attendanceStart") ?? undefined,
    attendanceEnd: map.get("attendanceEnd") ?? undefined,
    defaultTimeZone: map.get("defaultTimeZone") ?? undefined,
    supportedTimeZones: map.get("supportedTimeZones") ? map.get("supportedTimeZones")!.split(",") : undefined,
  });

  return {
    companyName: map.get("companyName") ?? settings.companyName,
    attendanceSchedule: {
      start: map.get("attendanceStart") ?? settings.attendanceSchedule.start,
      end: map.get("attendanceEnd") ?? settings.attendanceSchedule.end,
    },
    defaultTimeZone: map.get("defaultTimeZone") ?? settings.defaultTimeZone,
    supportedTimeZones: map.get("supportedTimeZones") ? map.get("supportedTimeZones")!.split(",") : settings.supportedTimeZones,
  };
}

export async function saveAppSetting({
  key,
  value,
  category,
  description,
  isAdminOnly,
  updatedById,
  database = prisma as any,
}: {
  key: string;
  value: string;
  category?: string;
  description?: string;
  isAdminOnly?: boolean;
  updatedById?: string | null;
  database?: any;
}) {
  const normalizedKey = key.trim();
  if (!normalizedKey) throw new Error("Setting key is required.");

  if (normalizedKey === "defaultTimeZone" && !isValidTimeZone(value.trim())) {
    throw new Error("Use a valid IANA timezone.");
  }

  if (Array.isArray(database?.appSettings)) {
    const existing = database.appSettings.find((item: any) => item.key === normalizedKey);
    if (existing) {
      existing.value = value;
      existing.category = category ?? existing.category ?? "GENERAL";
      existing.description = description ?? existing.description ?? null;
      existing.isAdminOnly = Boolean(isAdminOnly);
      existing.updatedById = updatedById ?? null;
      return existing;
    }
    const record = {
      id: `setting-${Date.now()}`,
      key: normalizedKey,
      value,
      category: category ?? "GENERAL",
      description: description ?? null,
      isAdminOnly: Boolean(isAdminOnly),
      updatedById: updatedById ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    database.appSettings.push(record);
    return record;
  }

  return database.appSetting.upsert({
    where: { key: normalizedKey },
    update: {
      value,
      category: category ?? "GENERAL",
      description: description ?? null,
      isAdminOnly: Boolean(isAdminOnly),
      updatedById: updatedById ?? null,
    },
    create: {
      key: normalizedKey,
      value,
      category: category ?? "GENERAL",
      description: description ?? null,
      isAdminOnly: Boolean(isAdminOnly),
      updatedById: updatedById ?? null,
    },
  });
}
