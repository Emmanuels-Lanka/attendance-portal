import "server-only";

import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import type { MonthlyEmployeeReport } from "@/lib/attendance/reports";
import { formatWorkedDuration } from "@/lib/attendance/history";

export type ReportExportCell = string | number | null;
export type MonthlyReportFormat = "pdf" | "csv" | "xlsx";

export function createMonthlyReportDownloadResponse(
  body: Buffer,
  format: MonthlyReportFormat,
  filenameStem: string,
  month: string,
) {
  const contentType = format === "xlsx"
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : format === "csv" ? "text/csv; charset=utf-8" : "application/pdf";
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filenameStem}-${month}.${format}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const monthlyAttendanceExportHeaders = [
  "Month",
  "Employees",
  "Employee ID",
  "Employee",
  "Department",
  "Sessions",
  "Completed sessions",
  "Active sessions",
  "Session time",
  "Scheduled workdays",
  "Present days",
  "Late days",
  "Early-out days",
  "Approved leave days",
  "Approved WFH days",
  "Holidays",
  "Absent days (saved)",
  "Missing-punch days",
  "Weekend days",
  "Undetermined days",
  "Calculated dates",
  "Engine hours",
  "Engine-calculated days",
  "Pending OT estimate hours",
  "Pending OT requests",
  "Approved OT estimate hours",
  "Approved OT requests",
  "Rejected OT estimate hours",
  "Rejected OT requests",
  "Recorded actual OT hours",
  "Recorded actual OT days",
  "Conflicting actual OT days",
] as const;

export type MonthlyAttendanceExportEmployee = {
  employeeId: string | null;
  name: string;
  departmentName: string | null;
  report: MonthlyEmployeeReport;
};

export type MonthlyAttendanceExportTotals = {
  employeeCount: number;
  totalSessions: number;
  totalWorkedMs: number;
  totalWorkingDays: number | null;
  presentDays: number | null;
  absentDays: number | null;
  lateDays: number | null;
  earlyOutDays: number | null;
  approvedLeaveDays: number | null;
  holidayDays: number;
  missingPunchDays: number | null;
  weekendDays: number | null;
  undeterminedDays: number | null;
  totalCalculatedDays: number;
  workFromHomeDays: number;
  engineWorkedMs: number | null;
  engineCalculatedDays: number;
  pendingExpectedHours: number;
  pendingRequestCount: number;
  approvedExpectedHours: number;
  approvedRequestCount: number;
  rejectedExpectedHours: number;
  rejectedRequestCount: number;
  recordedActualHours: number | null;
  recordedActualDays: number;
  conflictingActualDays: number;
};

export function monthlyEmployeeExportTotals(report: MonthlyEmployeeReport): MonthlyAttendanceExportTotals {
  return {
    employeeCount: 1,
    totalSessions: report.summary.totalSessions,
    totalWorkedMs: report.summary.totalWorkedMs,
    totalWorkingDays: report.summary.totalWorkingDays ?? null,
    presentDays: report.summary.presentDays ?? null,
    absentDays: report.summary.absentDays ?? null,
    lateDays: report.summary.lateDays ?? null,
    earlyOutDays: report.summary.earlyOutDays ?? null,
    approvedLeaveDays: report.summary.approvedLeaveDays ?? null,
    holidayDays: report.summary.holidayDays ?? 0,
    missingPunchDays: report.summary.missingPunchDays ?? null,
    weekendDays: report.summary.weekendDays ?? null,
    undeterminedDays: report.summary.undeterminedDays ?? null,
    totalCalculatedDays: report.summary.totalCalculatedDays ?? 0,
    workFromHomeDays: report.summary.workFromHomeDays ?? 0,
    engineWorkedMs: report.summary.engineWorkedMs ?? null,
    engineCalculatedDays: report.summary.engineCalculatedDays ?? 0,
    pendingExpectedHours: report.summary.pendingExpectedOvertimeHours ?? 0,
    pendingRequestCount: report.summary.pendingOvertimeRequestCount ?? 0,
    approvedExpectedHours: report.summary.approvedExpectedOvertimeHours ?? 0,
    approvedRequestCount: report.summary.approvedOvertimeRequestCount ?? 0,
    rejectedExpectedHours: report.summary.rejectedExpectedOvertimeHours ?? 0,
    rejectedRequestCount: report.summary.rejectedOvertimeRequestCount ?? 0,
    recordedActualHours: report.summary.recordedActualOvertimeHours ?? null,
    recordedActualDays: report.summary.recordedActualOvertimeDays ?? 0,
    conflictingActualDays: report.summary.conflictingActualOvertimeDays ?? 0,
  };
}

function attendanceStatus(value: number | null | undefined, emptyLabel: string) {
  return value === null || value === undefined ? emptyLabel : value;
}

function employeeRow(month: string, { employeeId, name, departmentName, report }: MonthlyAttendanceExportEmployee): ReportExportCell[] {
  const { summary } = report;
  return [
    month,
    1,
    employeeId ?? "",
    name,
    departmentName ?? "Unassigned",
    summary.totalSessions,
    summary.completedSessions,
    summary.activeSessions,
    formatWorkedDuration(summary.totalWorkedMs),
    attendanceStatus(summary.totalWorkingDays, "Unavailable"),
    attendanceStatus(summary.presentDays, "Not calculated"),
    attendanceStatus(summary.lateDays, "Not calculated"),
    attendanceStatus(summary.earlyOutDays, "Not calculated"),
    attendanceStatus(summary.approvedLeaveDays, "Unavailable"),
    summary.workFromHomeDays ?? 0,
    summary.holidayDays ?? 0,
    attendanceStatus(summary.absentDays, "Not recorded"),
    attendanceStatus(summary.missingPunchDays, "Not calculated"),
    attendanceStatus(summary.weekendDays, "Not calculated"),
    attendanceStatus(summary.undeterminedDays, "Not calculated"),
    summary.totalCalculatedDays ?? 0,
    summary.engineWorkedMs == null ? "Not calculated" : formatWorkedDuration(summary.engineWorkedMs),
    summary.engineCalculatedDays ?? 0,
    (summary.pendingExpectedOvertimeHours ?? 0).toFixed(2),
    summary.pendingOvertimeRequestCount ?? 0,
    (summary.approvedExpectedOvertimeHours ?? 0).toFixed(2),
    summary.approvedOvertimeRequestCount ?? 0,
    (summary.rejectedExpectedOvertimeHours ?? 0).toFixed(2),
    summary.rejectedOvertimeRequestCount ?? 0,
    summary.recordedActualOvertimeHours == null ? "Not recorded" : summary.recordedActualOvertimeHours.toFixed(2),
    summary.recordedActualOvertimeDays ?? 0,
    summary.conflictingActualOvertimeDays ?? 0,
  ];
}

function totalRow(month: string, totals: MonthlyAttendanceExportTotals): ReportExportCell[] {
  return [
    month,
    totals.employeeCount,
    "",
    "TOTAL",
    "",
    totals.totalSessions,
    "",
    "",
    formatWorkedDuration(totals.totalWorkedMs),
    attendanceStatus(totals.totalWorkingDays, "Unavailable"),
    attendanceStatus(totals.presentDays, "Not calculated"),
    attendanceStatus(totals.lateDays, "Not calculated"),
    attendanceStatus(totals.earlyOutDays, "Not calculated"),
    attendanceStatus(totals.approvedLeaveDays, "Unavailable"),
    totals.workFromHomeDays,
    totals.holidayDays,
    attendanceStatus(totals.absentDays, "Not recorded"),
    attendanceStatus(totals.missingPunchDays, "Not calculated"),
    attendanceStatus(totals.weekendDays, "Not calculated"),
    attendanceStatus(totals.undeterminedDays, "Not calculated"),
    totals.totalCalculatedDays,
    totals.engineWorkedMs === null ? "Not calculated" : formatWorkedDuration(totals.engineWorkedMs),
    totals.engineCalculatedDays,
    totals.pendingExpectedHours.toFixed(2),
    totals.pendingRequestCount,
    totals.approvedExpectedHours.toFixed(2),
    totals.approvedRequestCount,
    totals.rejectedExpectedHours.toFixed(2),
    totals.rejectedRequestCount,
    totals.recordedActualHours === null ? "Not recorded" : totals.recordedActualHours.toFixed(2),
    totals.recordedActualDays,
    totals.conflictingActualDays,
  ];
}

export function buildMonthlyAttendanceExportRows(
  month: string,
  employees: MonthlyAttendanceExportEmployee[],
  totals?: MonthlyAttendanceExportTotals,
) {
  const rows = employees.map((employee) => employeeRow(month, employee));
  if (totals) rows.push(totalRow(month, totals));
  return rows;
}

function safeCsvValue(value: ReportExportCell) {
  const text = value === null ? "" : String(value);
  const safeText = /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

export function createCsvReport(headers: readonly string[], rows: readonly ReportExportCell[][]) {
  const content = [headers, ...rows].map((row) => row.map(safeCsvValue).join(",")).join("\r\n");
  return Buffer.from(`\uFEFF${content}\r\n`, "utf8");
}

export async function createXlsxReport(sheetName: string, headers: readonly string[], rows: readonly ReportExportCell[][]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "EML – Attendance System";
  workbook.company = "Emmanuel's Lanka Pvt Ltd";
  const worksheet = workbook.addWorksheet(sheetName);
  worksheet.addRow([...headers]);
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.addRows(rows.map((row) => [...row]));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}