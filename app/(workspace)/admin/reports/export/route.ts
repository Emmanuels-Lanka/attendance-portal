import { NextRequest, NextResponse } from "next/server";
import { createMonthlyAttendancePdf } from "@/lib/attendance/monthly-pdf";
import { getMonthlyAttendanceSummaryReport } from "@/lib/attendance/reports";
import { createMonthlyReportDownloadResponse } from "@/lib/attendance/report-export";
import { requirePageAdmin } from "@/lib/auth/session";

export async function GET(request: NextRequest) {
  const admin = await requirePageAdmin();
  const month = request.nextUrl.searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return new NextResponse("Invalid report month.", { status: 400 });
  const { employees, summary } = await getMonthlyAttendanceSummaryReport(admin, month);
  const pdf = await createMonthlyAttendancePdf({
    month,
    title: "Company attendance",
    employees: employees.map(({ employee, report }) => ({
      name: employee.name,
      employeeCode: employee.employeeCode,
      departmentName: employee.departmentName,
      timeZone: employee.timeZone,
      report,
    })),
    summary,
  });

  return createMonthlyReportDownloadResponse(pdf, "pdf", "attendance-summary", month);
}
