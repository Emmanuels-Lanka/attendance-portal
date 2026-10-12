import assert from "node:assert/strict";
import { describe, it } from "node:test";
import nextConfig from "../../next.config";
import { attendanceStatusSummaryText, createMonthlyAttendancePdf, overtimeSummaryText } from "./monthly-pdf";

describe("monthly attendance PDF export", () => {
  it("creates a PDF containing the monthly summary and attendance rows", async () => {
    const pdf = await createMonthlyAttendancePdf({
      month: "2026-06",
      title: "Employee attendance",
      employees: [{
        name: "Jane Employee",
        email: "jane@example.invalid",
        timeZone: "Asia/Colombo",
        report: {
          monthLabel: "2026-06",
          empty: false,
          summary: {
            totalSessions: 1,
            completedSessions: 1,
            activeSessions: 0,
            totalWorkedMs: 8 * 60 * 60 * 1000,
            totalWorkingDays: 20,
            presentDays: 4,
            absentDays: null,
            lateDays: 1,
            earlyOutDays: 0,
            approvedLeaveDays: 2,
            holidayDays: 1,
            missingPunchDays: 1,
            weekendDays: 4,
            undeterminedDays: 0,
            totalCalculatedDays: 12,
            workFromHomeDays: 1,
            pendingExpectedOvertimeHours: 0,
            pendingOvertimeRequestCount: 0,
            approvedExpectedOvertimeHours: 1.5,
            approvedOvertimeRequestCount: 1,
            rejectedExpectedOvertimeHours: 0,
            rejectedOvertimeRequestCount: 0,
            recordedActualOvertimeHours: null,
            recordedActualOvertimeDays: 0,
            conflictingActualOvertimeDays: 0,
          },
          days: [{
            date: "2026-06-15",
            sessions: [{
              id: "session-1",
              mode: "OFFICE",
              startAt: new Date("2026-06-15T03:30:00.000Z"),
              endAt: new Date("2026-06-15T11:30:00.000Z"),
            }],
            totalWorkedMs: 8 * 60 * 60 * 1000,
          }],
        },
      }],
      summary: {
        employeeCount: 1,
        totalSessions: 1,
        totalWorkedMs: 8 * 60 * 60 * 1000,
        totalWorkingDays: 20,
        presentDays: 4,
        absentDays: null,
        lateDays: 1,
        earlyOutDays: 0,
        approvedLeaveDays: 2,
        holidayDays: 1,
        missingPunchDays: 1,
        weekendDays: 4,
        undeterminedDays: 0,
        totalCalculatedDays: 12,
        workFromHomeDays: 1,
        pendingExpectedHours: 0,
        pendingRequestCount: 0,
        approvedExpectedHours: 1.5,
        approvedRequestCount: 1,
        rejectedExpectedHours: 0,
        rejectedRequestCount: 0,
        recordedActualHours: null,
        recordedActualEmployees: 0,
        recordedActualDays: 0,
        conflictingActualDays: 0,
      },
    });


    assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
    const pdfSource = pdf.toString("latin1");
    assert.ok(pdfSource.includes("/Type /Page"));
    assert.ok(pdfSource.includes("/Subtype /Image"));
    assert.ok(pdfSource.includes("/FontFile2"));
    assert.ok(pdf.subarray(-20).toString("ascii").includes("%%EOF"));
  });

  it("summarizes saved attendance statuses and keeps unavailable values explicit", () => {
    assert.equal(attendanceStatusSummaryText({
      totalSessions: 1,
      totalWorkedMs: 0,
      totalWorkingDays: 20,
      presentDays: 4,
      absentDays: null,
      lateDays: 1,
      earlyOutDays: 0,
      approvedLeaveDays: 2,
      holidayDays: 1,
      missingPunchDays: 1,
      weekendDays: 4,
      undeterminedDays: 0,
      totalCalculatedDays: 12,
      workFromHomeDays: 1,
    }), "Attendance days: scheduled 20; present 4; late 1; early out 0; approved leave 2; WFH 1; holidays 1; absent Not recorded; missing punch 1; weekend 4; undetermined 0; calculated dates 12");
  });

  it("formats overtime estimates separately from recorded actual overtime", () => {
    assert.equal(overtimeSummaryText({
      totalSessions: 0,
      totalWorkedMs: 0,
      pendingExpectedHours: 0.5,
      pendingRequestCount: 1,
      approvedExpectedHours: 1.5,
      approvedRequestCount: 1,
      rejectedExpectedHours: 0,
      rejectedRequestCount: 0,
      recordedActualHours: 3.25,
      recordedActualEmployees: 1,
      recordedActualDays: 2,
      conflictingActualDays: 1,
    }), "OT request estimates: pending 0.50 h (1 requests); approved 1.50 h (1 requests); rejected 0.00 h (0 requests) | Recorded actual OT: 3.25 h across 2 employee-days from 1 employees; 1 conflicting days excluded");
  });

  it("generates employee and management PDFs for empty reports and special-character identities", async () => {
    const report = {
      monthLabel: "2026-06",
      empty: true,
      summary: {
        totalSessions: 0,
        completedSessions: 0,
        activeSessions: 0,
        totalWorkedMs: 0,
        absentDays: null,
        recordedActualOvertimeHours: null,
      },
      days: [],
    };
    const employee = {
      name: "Zoë 東京 😀",
      email: "zoe@example.invalid",
      employeeCode: "E-002",
      departmentName: "People & Research",
      timeZone: "Asia/Colombo",
      report,
    };
    const managementEmployee = {
      ...employee,
      report: {
        ...report,
        empty: false,
        days: [{
          date: "2026-06-15",
          sessions: [],
          totalWorkedMs: 0,
          approvedWorkFromHome: true,
        }],
      },
    };

    const employeePdf = await createMonthlyAttendancePdf({
      month: "2026-06",
      title: "Employee attendance",
      employees: [employee],
      summary: { totalSessions: 0, totalWorkedMs: 0 },
    });
    const managementPdf = await createMonthlyAttendancePdf({
      month: "2026-06",
      title: "Organization attendance",
      employees: [managementEmployee],
      summary: { employeeCount: 1, totalSessions: 0, totalWorkedMs: 0 },
    });

    for (const pdf of [employeePdf, managementPdf]) {
      assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
      assert.ok(pdf.subarray(-20).toString("ascii").includes("%%EOF"));
      assert.ok(pdf.toString("latin1").includes("/Type /Page"));
    }
  });

  it("paginates long attendance tables without failing", async () => {
    const pdf = await createMonthlyAttendancePdf({
      month: "2026-06",
      title: "Employee attendance",
      employees: [{
        name: "Jane Employee",
        timeZone: "Asia/Colombo",
        report: {
          monthLabel: "2026-06",
          empty: false,
          summary: {
            totalSessions: 80,
            completedSessions: 0,
            activeSessions: 80,
            totalWorkedMs: 0,
          },
          days: [{
            date: "2026-06-15",
            totalWorkedMs: 0,
            sessions: Array.from({ length: 80 }, (_, index) => ({
              id: `session-${index}`,
              mode: "OFFICE" as const,
              startAt: new Date("2026-06-15T03:30:00.000Z"),
              endAt: null,
            })),
          }],
        },
      }],
      summary: { totalSessions: 80, totalWorkedMs: 0 },
    });

    const pages = pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? [];
    assert.ok(pages.length > 1);
    assert.ok(pdf.subarray(-20).toString("ascii").includes("%%EOF"));
  });

  it("includes PDFKit's dynamically loaded standard-font modules in every route trace", () => {
    const tracePattern = "./node_modules/pdfkit/js/standard-fonts/**/*.cjs";
    for (const route of ["/reports/export", "/reports/monthly/export", "/admin/reports/export"]) {
      assert.ok(nextConfig.outputFileTracingIncludes?.[route]?.includes(tracePattern));
    }
  });
});