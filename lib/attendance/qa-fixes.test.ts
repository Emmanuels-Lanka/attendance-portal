/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMonthlyEmployeeReport, createNotification, getSettingsSnapshot } from "./qa-fixes";

describe("attendance QA implementation helpers", () => {
  it("uses the approved company name when no stored setting is available", () => {
    assert.equal(getSettingsSnapshot().companyName, "Emmanuel's Lanka Pvt Ltd");
  });

  it("groups employee records by local month and keeps empty months explicit", () => {
    const report = buildMonthlyEmployeeReport({
      id: "employee-1",
      name: "Jane Doe",
      timeZone: "Asia/Colombo",
      email: "jane@example.com",
    }, "2026-06", [
      { id: "s1", mode: "OFFICE", startAt: new Date("2026-06-02T08:45:00.000Z"), endAt: new Date("2026-06-02T17:20:00.000Z") },
      { id: "s2", mode: "WFH", startAt: new Date("2026-06-05T09:00:00.000Z"), endAt: new Date("2026-06-05T17:10:00.000Z") },
      { id: "s3", mode: "OFFICE", startAt: new Date("2026-06-16T08:00:00.000Z"), endAt: null },
    ]);

    assert.equal(report.monthLabel, "2026-06");
    assert.equal(report.summary.totalSessions, 3);
    assert.equal(report.summary.completedSessions, 2);
    assert.equal(report.days.length >= 2, true);
    assert.equal(report.empty, false);
  });

  it("deduplicates generic notifications", async () => {
    const database: any = {
      notifications: [
        { id: "n-1", userId: "employee-1", title: "System update", message: "A workspace update is available.", type: "INFO", readAt: null },
      ],
    };

    const created = await createNotification({
      userId: "employee-1",
      title: "System update",
      message: "A workspace update is available.",
      type: "INFO",
      database,
    });

    assert.equal(created.duplicate, true);
    assert.equal(database.notifications.length, 1);
  });

  it("keeps default settings consistent and validates timezone values", () => {
    const settings = getSettingsSnapshot({
      companyName: "Emmanuel's Lanka Pvt Ltd",
      attendanceStart: "08:30",
      attendanceEnd: "17:30",
      defaultTimeZone: "Asia/Colombo",
      supportedTimeZones: ["Asia/Colombo", "Asia/Dhaka"],
    });

    assert.equal(settings.companyName, "Emmanuel's Lanka Pvt Ltd");
    assert.equal(settings.attendanceSchedule.start, "08:30");
    assert.equal(settings.attendanceSchedule.end, "17:30");
    assert.equal(settings.defaultTimeZone, "Asia/Colombo");
    assert.equal(settings.supportedTimeZones.includes("Asia/Dhaka"), true);
  });
});
