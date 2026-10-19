import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
import {
  buildMonthlyAttendanceExportRows,
  createCsvReport,
  createMonthlyReportDownloadResponse,
  createXlsxReport,
  monthlyAttendanceExportHeaders,
  type MonthlyAttendanceExportTotals,
} from "./report-export";

const totals: MonthlyAttendanceExportTotals = {
  employeeCount: 1,
  totalSessions: 2,
  totalWorkedMs: 28_800_000,
  totalWorkingDays: 20,
  presentDays: 1,
  absentDays: null,
  lateDays: 0,
  earlyOutDays: 0,
  approvedLeaveDays: 1,
  holidayDays: 1,
  missingPunchDays: 0,
  weekendDays: 4,
  undeterminedDays: 0,
  totalCalculatedDays: 7,
  workFromHomeDays: 1,
  engineWorkedMs: 28_800_000,
  engineCalculatedDays: 1,
  pendingExpectedHours: 0,
  pendingRequestCount: 0,
  approvedExpectedHours: 1.5,
  approvedRequestCount: 1,
  rejectedExpectedHours: 0,
  rejectedRequestCount: 0,
  recordedActualHours: null,
  recordedActualDays: 0,
  conflictingActualDays: 0,
};

const employees = [{
  employeeId: "E-001",
  name: '=HYPERLINK("https://example.invalid")',
  departmentName: "People, Research",
  report: {
    monthLabel: "2026-06",
    empty: false,
    summary: {
      totalSessions: 2,
      completedSessions: 1,
      activeSessions: 1,
      totalWorkedMs: 28_800_000,
      totalWorkingDays: 20,
      presentDays: 1,
      absentDays: null,
      lateDays: 0,
      earlyOutDays: 0,
      approvedLeaveDays: 1,
      workFromHomeDays: 1,
      holidayDays: 1,
      missingPunchDays: 0,
      weekendDays: 4,
      undeterminedDays: 0,
      totalCalculatedDays: 7,
      engineWorkedMs: 28_800_000,
      engineCalculatedDays: 1,
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
    days: [],
  },
}];

describe("monthly attendance report exports", () => {
  it("sets correct download content types, filenames, and private cache policy", () => {
    const expected = [
      ["pdf", "application/pdf", 'attachment; filename="attendance-2026-06.pdf"'],
      ["csv", "text/csv; charset=utf-8", 'attachment; filename="attendance-2026-06.csv"'],
      ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 'attachment; filename="attendance-2026-06.xlsx"'],
    ] as const;
    for (const [format, contentType, contentDisposition] of expected) {
      const response = createMonthlyReportDownloadResponse(Buffer.from("report"), format, "attendance", "2026-06");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Content-Type"), contentType);
      assert.equal(response.headers.get("Content-Disposition"), contentDisposition);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    }
  });

  it("creates CSV headers, employee rows, totals, safe formula text, and quoted fields", () => {
    const rows = buildMonthlyAttendanceExportRows("2026-06", employees, totals);
    const csv = createCsvReport(monthlyAttendanceExportHeaders, rows).toString("utf8");

    assert.ok(csv.startsWith("\uFEFF\"Month\",\"Employees\""));
    assert.ok(csv.includes("\"E-001\",\"'=HYPERLINK("));
    assert.ok(csv.includes("\"People, Research\""));
    assert.ok(csv.includes("\"Absent days (saved)\""));
    assert.ok(csv.includes("\"TOTAL\""));
    assert.ok(csv.includes("\"Not recorded\""));
    assert.ok(csv.includes("\"1.50\""));
  });

  it("creates an XLSX workbook ExcelJS can reopen with headers, dates, scope, and totals", async () => {
    const rows = buildMonthlyAttendanceExportRows("2026-06", employees, totals);
    const buffer = await createXlsxReport("Attendance", monthlyAttendanceExportHeaders, rows);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const worksheet = workbook.getWorksheet("Attendance");

    assert.ok(buffer.subarray(0, 2).equals(Buffer.from("PK")));
    assert.equal(workbook.creator, "EML – Attendance System");
    assert.equal(workbook.company, "Emmanuel's Lanka Pvt Ltd");
    assert.equal(worksheet?.getCell(1, 1).value, "Month");
    assert.equal(worksheet?.getCell(1, 17).value, "Absent days (saved)");
    assert.equal(worksheet?.getCell(2, 4).value, '=HYPERLINK("https://example.invalid")');
    assert.equal(worksheet?.getCell(2, 5).value, "People, Research");
    assert.equal(worksheet?.getCell(3, 4).value, "TOTAL");
    assert.equal(worksheet?.getCell(3, 2).value, 1);
    assert.equal(worksheet?.getCell(3, 25).value, 0);
  });

  it("keeps headers and a zero-count totals row for an empty report", async () => {
    const emptyTotals = { ...totals, employeeCount: 0, totalSessions: 0, totalWorkedMs: 0 };
    const rows = buildMonthlyAttendanceExportRows("2026-06", [], emptyTotals);
    const csv = createCsvReport(monthlyAttendanceExportHeaders, rows).toString("utf8");
    const workbook = new ExcelJS.Workbook();
    const buffer = await createXlsxReport("Attendance", monthlyAttendanceExportHeaders, rows);
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

    assert.equal(rows.length, 1);
    assert.ok(csv.includes("\"TOTAL\""));
    assert.equal(workbook.getWorksheet("Attendance")?.rowCount, 2);
    assert.equal(workbook.getWorksheet("Attendance")?.getCell(2, 2).value, 0);
  });
});