import { NextRequest, NextResponse } from "next/server";
import { formatInTimeZone } from "date-fns-tz";
import { createMonthlyAttendancePdf } from "@/lib/attendance/monthly-pdf";
import { getMonthlyAttendanceSummaryReport, MonthlySummaryAccessError } from "@/lib/attendance/reports";
import {
  buildMonthlyAttendanceExportRows,
  createCsvReport,
  createMonthlyReportDownloadResponse,
  createXlsxReport,
  monthlyAttendanceExportHeaders,
} from "@/lib/attendance/report-export";
import { requirePageUser } from "@/lib/auth/session";
import { getCompanyName } from "@/lib/attendance/settings";

export async function GET(request: NextRequest) {
  const actor = await requirePageUser();
  const companyName = await getCompanyName();
  const month = request.nextUrl.searchParams.get("month") ?? formatInTimeZone(new Date(), actor.timeZone, "yyyy-MM");
  const employeeId = request.nextUrl.searchParams.get("employeeId") ?? "";
  const departmentId = request.nextUrl.searchParams.get("departmentId") ?? "";
  const format = request.nextUrl.searchParams.get("format") ?? "pdf";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return new NextResponse("Invalid report month.", { status: 400 });
  if (departmentId.length > 100) return new NextResponse("Invalid report department.", { status: 400 });
  if (format !== "pdf" && format !== "csv" && format !== "xlsx") return new NextResponse("Invalid report format.", { status: 400 });

  let report;
  try {
    report = await getMonthlyAttendanceSummaryReport(actor, month, employeeId, undefined, departmentId);
  } catch (error) {
    if (error instanceof MonthlySummaryAccessError) return new NextResponse("You do not have access to this report.", { status: 403 });
    console.error("Monthly attendance export failed", error instanceof Error ? error.name : "Unknown error");
    return new NextResponse("The attendance report could not be generated.", { status: 500 });
  }

  const employees = report.employees.map(({ employee, report: employeeReport }) => ({
    employeeId: employee.employeeCode,
    name: employee.name,
    departmentName: employee.departmentName,
    report: employeeReport,
  }));
  let body: Buffer;
  if (format === "csv" || format === "xlsx") {
    const rows = buildMonthlyAttendanceExportRows(month, employees, report.summary);
    body = format === "csv"
      ? createCsvReport(monthlyAttendanceExportHeaders, rows)
      : await createXlsxReport("Attendance", monthlyAttendanceExportHeaders, rows, companyName);
  } else {
    body = await createMonthlyAttendancePdf({
      month,
      title: actor.role === "DEPARTMENT_MANAGER" ? "Department attendance" : "Organization attendance",
      companyName,
      employees: report.employees.map(({ employee, report: employeeReport }) => ({
        name: employee.name,
        employeeCode: employee.employeeCode,
        departmentName: employee.departmentName,
        timeZone: employee.timeZone,
        report: employeeReport,
      })),
      summary: report.summary,
    });
  }

  return createMonthlyReportDownloadResponse(body, format, "attendance-summary", month);
}