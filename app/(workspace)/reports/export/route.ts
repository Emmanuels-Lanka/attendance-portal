import { NextRequest, NextResponse } from "next/server";
import { formatInTimeZone } from "date-fns-tz";
import { createMonthlyAttendancePdf } from "@/lib/attendance/monthly-pdf";
import { getEmployeeMonthlyReport } from "@/lib/attendance/reports";
import {
  buildMonthlyAttendanceExportRows,
  createCsvReport,
  createMonthlyReportDownloadResponse,
  createXlsxReport,
  monthlyAttendanceExportHeaders,
  monthlyEmployeeExportTotals,
} from "@/lib/attendance/report-export";
import { requirePageUser } from "@/lib/auth/session";
import { getCompanyName } from "@/lib/attendance/settings";

export async function GET(request: NextRequest) {
  const user = await requirePageUser();
  if (user.role === "ADMIN") return new NextResponse("Personal attendance reports are not available to Super Administrators.", { status: 403 });
  const companyName = await getCompanyName();
  const month = request.nextUrl.searchParams.get("month") ?? formatInTimeZone(new Date(), user.timeZone, "yyyy-MM");
  const format = request.nextUrl.searchParams.get("format") ?? "pdf";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return new NextResponse("Invalid report month.", { status: 400 });
  if (format !== "pdf" && format !== "csv" && format !== "xlsx") return new NextResponse("Invalid report format.", { status: 400 });
  const report = await getEmployeeMonthlyReport(user, month);
  const employees = [{ employeeId: null, name: user.name, departmentName: "", report }];
  let body: Buffer;
  if (format === "csv" || format === "xlsx") {
    const rows = buildMonthlyAttendanceExportRows(month, employees, monthlyEmployeeExportTotals(report));
    body = format === "csv"
      ? createCsvReport(monthlyAttendanceExportHeaders, rows)
      : await createXlsxReport("Attendance", monthlyAttendanceExportHeaders, rows, companyName);
  } else {
    body = await createMonthlyAttendancePdf({
      month,
      title: "Employee attendance",
      companyName,
      employees: [{ name: user.name, email: user.email, timeZone: user.timeZone, report }],
      summary: {
        totalSessions: report.summary.totalSessions,
        totalWorkedMs: report.summary.totalWorkedMs,
        totalWorkingDays: report.summary.totalWorkingDays,
        presentDays: report.summary.presentDays,
        absentDays: report.summary.absentDays,
        lateDays: report.summary.lateDays,
        earlyOutDays: report.summary.earlyOutDays,
        approvedLeaveDays: report.summary.approvedLeaveDays,
        holidayDays: report.summary.holidayDays,
        unmatchedScopedHolidayDates: report.summary.unmatchedScopedHolidayDates,
        missingPunchDays: report.summary.missingPunchDays,
        weekendDays: report.summary.weekendDays,
        undeterminedDays: report.summary.undeterminedDays,
        totalCalculatedDays: report.summary.totalCalculatedDays,
        workFromHomeDays: report.summary.workFromHomeDays,
        engineWorkedMs: report.summary.engineWorkedMs,
        engineCalculatedDays: report.summary.engineCalculatedDays,
        pendingExpectedHours: report.summary.pendingExpectedOvertimeHours,
        pendingRequestCount: report.summary.pendingOvertimeRequestCount,
        approvedExpectedHours: report.summary.approvedExpectedOvertimeHours,
        approvedRequestCount: report.summary.approvedOvertimeRequestCount,
        rejectedExpectedHours: report.summary.rejectedExpectedOvertimeHours,
        rejectedRequestCount: report.summary.rejectedOvertimeRequestCount,
        recordedActualHours: report.summary.recordedActualOvertimeHours,
        recordedActualEmployees: report.summary.recordedActualOvertimeEmployees,
        recordedActualDays: report.summary.recordedActualOvertimeDays,
        conflictingActualDays: report.summary.conflictingActualOvertimeDays,
      },
    });
  }
  return createMonthlyReportDownloadResponse(body, format, "attendance-report", month);
}
