import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { EmployeeForm } from "@/components/employee-form";
import { requirePagePermission } from "@/lib/auth/session";
import { getEmployee, listEmployeeReportingOptions } from "@/lib/employees/service";
import { listOrganizationOptions } from "@/lib/organization/service";
import { listShiftOptions } from "@/lib/shifts/service";

export default async function EditEmployeePage({ params }: { params: Promise<{ employeeId: string }> }) {
  const admin = await requirePagePermission("employee:manage");
  const { employeeId } = await params;
  let employee;
  const [organizationOptions, shifts, reportingOptions] = await Promise.all([
    listOrganizationOptions(admin),
    listShiftOptions(admin),
    listEmployeeReportingOptions(admin),
  ]);
  try {
    employee = await getEmployee(admin, employeeId);
  } catch {
    notFound();
  }
  if (!employee.user) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/admin/employees/${employee.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-[var(--muted)] hover:text-[var(--ink)]"><ChevronLeft size={16} aria-hidden="true" /> Employee details</Link>
        <p className="mt-5 text-sm font-medium text-[var(--blue)]">Administration</p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Edit employee</h1>
      </div>
      <EmployeeForm employee={{
        id: employee.user.id,
        name: employee.name,
        employeeCode: employee.employeeId,
        nic: employee.nic,
        epfId: employee.epfId,
        etfId: employee.etfId,
        departmentId: employee.departmentId,
        designationId: employee.designationId,
        shiftId: employee.shiftId,
        supervisorId: employee.supervisorId,
        managerId: employee.managerId,
        email: employee.user.email,
        username: employee.user.username,
        role: employee.user.role,
        countryCode: employee.user.countryCode,
        timeZone: employee.user.timeZone,
        profile: employee.profile,
      }} canManageAdministratorRoles={admin.role === "ADMIN"} departments={organizationOptions.departments} designations={organizationOptions.designations} shifts={shifts} supervisors={reportingOptions.supervisors} managers={reportingOptions.managers} />
    </div>
  );
}