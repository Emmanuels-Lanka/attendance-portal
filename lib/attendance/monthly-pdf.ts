import "server-only";

import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatInTimeZone } from "date-fns-tz";
import type { MonthlyEmployeeReport } from "@/lib/attendance/reports";
import { formatWorkedDuration } from "@/lib/attendance/history";

type PdfEmployee = {
  name: string;
  email?: string;
  employeeCode?: string | null;
  departmentName?: string | null;
  timeZone: string;
  report: MonthlyEmployeeReport;
};

type PdfSummary = {
  employeeCount?: number;
  totalSessions: number;
  totalWorkedMs: number;
  totalWorkingDays?: number | null;
  presentDays?: number | null;
  absentDays?: number | null;
  lateDays?: number | null;
  earlyOutDays?: number | null;
  approvedLeaveDays?: number | null;
  holidayDays?: number | null;
  unmatchedScopedHolidayDates?: number;
  missingPunchDays?: number | null;
  weekendDays?: number | null;
  undeterminedDays?: number | null;
  totalCalculatedDays?: number;
  workFromHomeDays?: number;
  engineWorkedMs?: number | null;
  engineCalculatedDays?: number;
  pendingExpectedHours?: number;
  pendingRequestCount?: number;
  approvedExpectedHours?: number;
  approvedRequestCount?: number;
  rejectedExpectedHours?: number;
  rejectedRequestCount?: number;
  recordedActualHours?: number | null;
  recordedActualEmployees?: number;
  recordedActualDays?: number;
  conflictingActualDays?: number;
};

export function overtimeSummaryText(summary: PdfSummary) {
  const actual = summary.recordedActualHours === null || summary.recordedActualHours === undefined
    ? "Not recorded"
    : `${summary.recordedActualHours.toFixed(2)} h across ${summary.recordedActualDays ?? 0} employee-days${summary.recordedActualEmployees !== undefined ? ` from ${summary.recordedActualEmployees} employees` : ""}`;
  const conflicts = summary.conflictingActualDays ? `; ${summary.conflictingActualDays} conflicting days excluded` : "";
  const pending = `${(summary.pendingExpectedHours ?? 0).toFixed(2)} h (${summary.pendingRequestCount ?? 0} requests)`;
  const approved = `${(summary.approvedExpectedHours ?? 0).toFixed(2)} h (${summary.approvedRequestCount ?? 0} requests)`;
  const rejected = `${(summary.rejectedExpectedHours ?? 0).toFixed(2)} h (${summary.rejectedRequestCount ?? 0} requests)`;
  return `OT request estimates: pending ${pending}; approved ${approved}; rejected ${rejected} | Recorded actual OT: ${actual}${conflicts}`;
}

export function attendanceStatusSummaryText(summary: PdfSummary) {
  const absent = summary.absentDays === null || summary.absentDays === undefined ? "Not recorded" : String(summary.absentDays);
  const scopedHolidays = summary.unmatchedScopedHolidayDates
    ? `; potential scoped holiday dates not applied ${summary.unmatchedScopedHolidayDates}`
    : "";
  return `Attendance days: scheduled ${summary.totalWorkingDays ?? "Unavailable"}; present ${summary.presentDays ?? "Not calculated"}; late ${summary.lateDays ?? "Not calculated"}; early out ${summary.earlyOutDays ?? "Not calculated"}; approved leave ${summary.approvedLeaveDays ?? "Unavailable"}; WFH ${summary.workFromHomeDays ?? 0}; holidays ${summary.holidayDays ?? 0}${scopedHolidays}; absent ${absent}; missing punch ${summary.missingPunchDays ?? "Not calculated"}; weekend ${summary.weekendDays ?? "Not calculated"}; undetermined ${summary.undeterminedDays ?? "Not calculated"}; calculated dates ${summary.totalCalculatedDays ?? 0}; approved leave excludes dates with attendance records`;
}

function safeCell(value: string, width: number, fontSize = 8) {
  const supported = value.normalize("NFC").replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
  const maxLength = Math.max(4, Math.floor(width / (fontSize * 0.55)));
  return supported.length > maxLength ? `${supported.slice(0, maxLength - 2)}..` : supported;
}

function employeeSubtitle(employee: PdfEmployee) {
  const identity = [employee.employeeCode, employee.departmentName, employee.email]
    .filter((value): value is string => Boolean(value))
    .map((value) => safeCell(value, 230));
  identity.push(`Timezone: ${safeCell(employee.timeZone, 150)}`);
  return identity.join(" | ");
}

function resolveProjectAssetPath(...segments: string[]) {
  const moduleRelative = fileURLToPath(new URL(`../../${segments.join("/")}`, import.meta.url));
  const cwdRelative = join(process.cwd(), ...segments);
  return existsSync(moduleRelative) ? moduleRelative : cwdRelative;
}

export async function createMonthlyAttendancePdf({
  month,
  employees,
  summary,
  title,
  companyName = "Emmanuel's Lanka Pvt Ltd",
}: {
  month: string;
  employees: PdfEmployee[];
  summary: PdfSummary;
  title: string;
  companyName?: string;
}) {
  const logo = await readFile(resolveProjectAssetPath("public", "eml-company-logo.png"));
  const fontDir = resolveProjectAssetPath("public", "fonts");
  const pdf = new PDFDocument({ size: "A4", margins: { top: 40, right: 40, bottom: 48, left: 40 }, bufferPages: true });
  pdf.registerFont("AppHelvetica", join(fontDir, "Helvetica.ttf"));
  pdf.registerFont("AppHelvetica-Bold", join(fontDir, "Helvetica-Bold.ttf"));
  pdf.registerFont("AppHelvetica-Oblique", join(fontDir, "Helvetica-Oblique.ttf"));
  pdf.registerFont("AppHelvetica-BoldOblique", join(fontDir, "Helvetica-BoldOblique.ttf"));
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });

  const pageWidth = pdf.page.width;
  const contentWidth = pageWidth - pdf.page.margins.left - pdf.page.margins.right;
  const drawHeader = () => {
    pdf.image(logo, pdf.page.margins.left, 34, { fit: [145, 50] });
    pdf.fillColor("#111111").font("AppHelvetica-Bold").fontSize(18).text(title, 205, 42, { width: contentWidth - 165 });
    pdf.fillColor("#444444").font("AppHelvetica").fontSize(10).text(`Monthly attendance report - ${month}`, 205, 68, { width: contentWidth - 165 });
    pdf.moveTo(pdf.page.margins.left, 101).lineTo(pageWidth - pdf.page.margins.right, 101).lineWidth(2).strokeColor("#0071c1").stroke();
    pdf.y = 112;
  };

  const columns = [
    { title: "Local date", width: 75 },
    { title: "Mode", width: 50 },
    { title: "IN", width: 98 },
    { title: "OUT", width: 98 },
    { title: "Duration", width: 78 },
    { title: "Status", width: 76 },
  ];
  const drawTableHeader = () => {
    let x = pdf.page.margins.left;
    const y = pdf.y;
    pdf.font("AppHelvetica-Bold").fontSize(8).fillColor("#0071c1");
    for (const column of columns) {
      pdf.text(column.title, x, y, { width: column.width, lineBreak: false });
      x += column.width;
    }
    pdf.y = y + 16;
    pdf.moveTo(pdf.page.margins.left, pdf.y).lineTo(pageWidth - pdf.page.margins.right, pdf.y).lineWidth(0.7).strokeColor("#d1d5db").stroke();
    pdf.y += 5;
  };

  const ensureTableRoom = () => {
    if (pdf.y + 38 <= pdf.page.height - pdf.page.margins.bottom) return;
    pdf.addPage();
    drawHeader();
    drawTableHeader();
  };

  drawHeader();
  pdf.font("AppHelvetica").fontSize(9).fillColor("#111111");
  if (summary.employeeCount === undefined && employees[0]) {
    const employee = employees[0];
    pdf.font("AppHelvetica-Bold").fontSize(11).text(safeCell(employee.name, contentWidth));
    pdf.font("AppHelvetica").fontSize(8.5).fillColor("#555555").text(employeeSubtitle(employee));
  } else {
    pdf.font("AppHelvetica-Bold").fontSize(11).text(`${title} summary`);
  }
  pdf.moveDown(0.6);
  const engineWorkedText = summary.engineWorkedMs === null || summary.engineWorkedMs === undefined
    ? "Engine hours: Not calculated"
    : `Engine hours: ${formatWorkedDuration(summary.engineWorkedMs)} (${summary.engineCalculatedDays ?? 0} calculated days)`;
  const summaryText = summary.employeeCount === undefined
    ? `Sessions: ${summary.totalSessions} | Completed: ${employees[0]?.report.summary.completedSessions ?? 0} | Active: ${employees[0]?.report.summary.activeSessions ?? 0} | Session time: ${formatWorkedDuration(summary.totalWorkedMs)} | ${engineWorkedText} | ${attendanceStatusSummaryText(summary)} | ${overtimeSummaryText(summary)}`
    : `Employees: ${summary.employeeCount} | Sessions: ${summary.totalSessions} | Session time: ${formatWorkedDuration(summary.totalWorkedMs)} | ${engineWorkedText} | ${attendanceStatusSummaryText(summary)} | ${overtimeSummaryText(summary)}`
    ;
  pdf.font("AppHelvetica-Bold").fontSize(9).fillColor("#111111").text(summaryText);
  pdf.moveDown(1);

  for (const employee of employees) {
    if (summary.employeeCount !== undefined) {
      if (pdf.y + 90 > pdf.page.height - pdf.page.margins.bottom) {
        pdf.addPage();
        drawHeader();
      }
      pdf.font("AppHelvetica-Bold").fontSize(11).fillColor("#111111").text(safeCell(employee.name, contentWidth));
      pdf.font("AppHelvetica").fontSize(8).fillColor("#555555").text(employeeSubtitle(employee));
      const engineWorked = employee.report.summary.engineWorkedMs === null || employee.report.summary.engineWorkedMs === undefined
        ? "Engine hours: Not calculated"
        : `Engine hours: ${formatWorkedDuration(employee.report.summary.engineWorkedMs)} (${employee.report.summary.engineCalculatedDays ?? 0} calculated days)`;
      const employeeOvertimeSummary = overtimeSummaryText({
        totalSessions: employee.report.summary.totalSessions,
        totalWorkedMs: employee.report.summary.totalWorkedMs,
        pendingExpectedHours: employee.report.summary.pendingExpectedOvertimeHours,
        pendingRequestCount: employee.report.summary.pendingOvertimeRequestCount,
        approvedExpectedHours: employee.report.summary.approvedExpectedOvertimeHours,
        approvedRequestCount: employee.report.summary.approvedOvertimeRequestCount,
        rejectedExpectedHours: employee.report.summary.rejectedExpectedOvertimeHours,
        rejectedRequestCount: employee.report.summary.rejectedOvertimeRequestCount,
        recordedActualHours: employee.report.summary.recordedActualOvertimeHours,
        recordedActualEmployees: employee.report.summary.recordedActualOvertimeEmployees,
        recordedActualDays: employee.report.summary.recordedActualOvertimeDays,
        conflictingActualDays: employee.report.summary.conflictingActualOvertimeDays,
      });
      pdf.font("AppHelvetica").fontSize(8).fillColor("#111111").text(`Sessions: ${employee.report.summary.totalSessions} | Completed: ${employee.report.summary.completedSessions} | Active: ${employee.report.summary.activeSessions} | Session time: ${formatWorkedDuration(employee.report.summary.totalWorkedMs)} | ${engineWorked} | ${attendanceStatusSummaryText(employee.report.summary)} | ${employeeOvertimeSummary}`);
      pdf.moveDown(0.5);
    }

    if (employee.report.days.length === 0) {
      pdf.font("AppHelvetica-Oblique").fontSize(8).fillColor("#555555").text("No attendance sessions were recorded for this month.");
      pdf.moveDown(0.5);
      continue;
    }

    drawTableHeader();
    for (const day of employee.report.days) {
      if (day.approvedWorkFromHome) {
        ensureTableRoom();
        const row = [day.date, "WFH", "-", "-", "-", "Approved"];
        let x = pdf.page.margins.left;
        const y = pdf.y;
        pdf.font("AppHelvetica").fontSize(8).fillColor("#111111");
        row.forEach((value, index) => {
          pdf.text(safeCell(value, columns[index].width), x, y, { width: columns[index].width, lineBreak: false });
          x += columns[index].width;
        });
        pdf.y = y + 18;
        pdf.moveTo(pdf.page.margins.left, pdf.y).lineTo(pageWidth - pdf.page.margins.right, pdf.y).lineWidth(0.35).strokeColor("#e5e7eb").stroke();
        pdf.y += 4;
      }
      for (const session of day.sessions) {
        ensureTableRoom();
        const validEnd = session.endAt !== null && session.endAt >= session.startAt;
        const status = session.endAt === null ? "Active" : validEnd ? "Completed" : "Invalid";
        const row = [
          day.date,
          session.mode === "WFH" ? "WFH" : "Office",
          formatInTimeZone(session.startAt, employee.timeZone, "HH:mm"),
          session.endAt ? formatInTimeZone(session.endAt, employee.timeZone, "HH:mm") : "-",
          validEnd ? formatWorkedDuration(session.endAt!.getTime() - session.startAt.getTime()) : "-",
          status,
        ];
        let x = pdf.page.margins.left;
        const y = pdf.y;
        pdf.font("AppHelvetica").fontSize(8).fillColor("#111111");
        row.forEach((value, index) => {
          pdf.text(safeCell(value, columns[index].width), x, y, { width: columns[index].width, lineBreak: false });
          x += columns[index].width;
        });
        pdf.y = y + 18;
        pdf.moveTo(pdf.page.margins.left, pdf.y).lineTo(pageWidth - pdf.page.margins.right, pdf.y).lineWidth(0.35).strokeColor("#e5e7eb").stroke();
        pdf.y += 4;
      }
    }
    pdf.moveDown(0.5);
  }

  const pageRange = pdf.bufferedPageRange();
  for (let index = 0; index < pageRange.count; index += 1) {
    pdf.switchToPage(pageRange.start + index);
    pdf.font("AppHelvetica").fontSize(8).fillColor("#666666").text(`EML – Attendance Management System | ${companyName} | ${month} | Page ${index + 1} of ${pageRange.count}`, pdf.page.margins.left, pdf.page.height - 32, { width: contentWidth, align: "right" });
  }
  pdf.end();
  return finished;
}