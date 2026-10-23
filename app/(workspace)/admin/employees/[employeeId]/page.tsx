import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, FileText, Pencil } from "lucide-react";
import { requirePagePermission } from "@/lib/auth/session";
import { EmployeeStatusForm } from "@/components/employee-status-form";
import { getEmployee } from "@/lib/employees/service";

function valueOrMissing(value: string | null | undefined) {
  return value || "Not provided";
}

function dateOrMissing(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : "Not provided";
}

function genderLabel(gender: string | null | undefined, custom: string | null | undefined) {
  if (gender === "MALE") return "Male";
  if (gender === "FEMALE") return "Female";
  if (gender === "PREFER_NOT_TO_SAY") return "Prefer Not to Say";
  return gender === "CUSTOM" ? valueOrMissing(custom) : "Not provided";
}

function roleLabel(role: string | undefined) {
  if (role === "ADMIN") return "Super Administrator";
  if (role === "HR_ADMINISTRATOR") return "HR Administrator";
  if (role === "DEPARTMENT_MANAGER") return "Department Manager";
  if (role === "SUPERVISOR") return "Supervisor";
  return role === "EMPLOYEE" ? "Employee" : "No account";
}

export default async function EmployeeDetailPage({ params }: { params: Promise<{ employeeId: string }> }) {
  const admin = await requirePagePermission("employee:manage");
  const { employeeId } = await params;
  let employee;
  try {
    employee = await getEmployee(admin, employeeId);
  } catch {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/employees" className="inline-flex items-center gap-1 text-sm font-medium text-[var(--muted)] hover:text-[var(--ink)]"><ChevronLeft size={16} aria-hidden="true" /> Employees</Link>
        <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
          <div><p className="text-sm font-medium text-[var(--blue)]">Employee details</p><h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">{employee.name}</h1><p className="mt-2 text-sm text-[var(--muted)]">Contact: {valueOrMissing(employee.profile?.email)}</p></div>
          <div className="flex flex-wrap gap-2">
            {admin.role === "ADMIN" && <Link href={`/admin/employees/${employee.id}/documents`} className="inline-flex h-10 items-center gap-2 rounded-md border border-[var(--line)] bg-white px-3.5 text-sm font-medium shadow-sm hover:bg-zinc-50"><FileText size={15} aria-hidden="true" /> Documents</Link>}
            {employee.user && <Link href={`/admin/employees/${employee.user.id}/edit`} className="inline-flex h-10 items-center gap-2 rounded-md border border-[var(--line)] bg-white px-3.5 text-sm font-medium shadow-sm hover:bg-zinc-50"><Pencil size={15} aria-hidden="true" /> Edit employee</Link>}
          </div>
        </div>
      </div>
      <section className="max-w-3xl rounded-lg border border-[var(--line)] bg-white shadow-sm">
        <dl className="grid gap-x-8 divide-y divide-[var(--line)] px-5 sm:grid-cols-2 sm:divide-y-0 sm:px-7">
          <div className="border-b border-[var(--line)] py-4"><dt className="text-xs text-[var(--muted)]">Employee ID</dt><dd className="mt-1.5 text-sm font-semibold">{valueOrMissing(employee.employeeId)}</dd></div>
          <div className="border-b border-[var(--line)] py-4"><dt className="text-xs text-[var(--muted)]">NIC</dt><dd className="mt-1.5 text-sm font-semibold">{valueOrMissing(employee.nic)}</dd></div>
          <div className="border-b border-[var(--line)] py-4"><dt className="text-xs text-[var(--muted)]">EPF number</dt><dd className="mt-1.5 text-sm font-semibold">{valueOrMissing(employee.epfId)}</dd></div>
          <div className="border-b border-[var(--line)] py-4"><dt className="text-xs text-[var(--muted)]">ETF number</dt><dd className="mt-1.5 text-sm font-semibold">{valueOrMissing(employee.etfId)}</dd></div>
          <div className="border-b border-[var(--line)] py-4"><dt className="text-xs text-[var(--muted)]">Department</dt><dd className="mt-1.5 text-sm font-semibold">{valueOrMissing(employee.department?.name)}</dd></div>
          <div className="border-b border-[var(--line)] py-4"><dt className="text-xs text-[var(--muted)]">Designation</dt><dd className="mt-1.5 text-sm font-semibold">{valueOrMissing(employee.designation?.name)}</dd></div>
          <div className="border-b border-[var(--line)] py-4"><dt className="text-xs text-[var(--muted)]">Shift</dt><dd className="mt-1.5 text-sm font-semibold">{valueOrMissing(employee.shift?.name)}</dd></div>
          <div className="border-b border-[var(--line)] py-4"><dt className="text-xs text-[var(--muted)]">Supervisor</dt><dd className="mt-1.5 text-sm font-semibold">{valueOrMissing(employee.supervisor?.name)}</dd></div>
          <div className="border-b border-[var(--line)] py-4"><dt className="text-xs text-[var(--muted)]">Department Manager</dt><dd className="mt-1.5 text-sm font-semibold">{valueOrMissing(employee.manager?.name)}</dd></div>
          <div className="border-b border-[var(--line)] py-4"><dt className="text-xs text-[var(--muted)]">Login email</dt><dd className="mt-1.5 text-sm font-semibold">{valueOrMissing(employee.user?.email)}</dd></div>
          <div className="border-b border-[var(--line)] py-4"><dt className="text-xs text-[var(--muted)]">Role</dt><dd className="mt-1.5 text-sm font-semibold">{roleLabel(employee.user?.role)}</dd></div>
          <div className="border-b border-[var(--line)] py-4"><dt className="text-xs text-[var(--muted)]">Country code</dt><dd className="mt-1.5 text-sm font-semibold">{valueOrMissing(employee.user?.countryCode)}</dd></div>
          <div className="border-b border-[var(--line)] py-4"><dt className="text-xs text-[var(--muted)]">IANA timezone</dt><dd className="mt-1.5 text-sm font-semibold">{valueOrMissing(employee.user?.timeZone)}</dd></div>
          <div className="py-4"><dt className="text-xs text-[var(--muted)]">Account status</dt><dd className="mt-1.5 text-sm font-semibold">{employee.user ? employee.user.isActive ? "Active" : "Inactive" : "No account"}</dd></div>
          <div className="py-4"><dt className="text-xs text-[var(--muted)]">Profile status</dt><dd className="mt-1.5 text-sm font-semibold">{employee.profileCompletedAt ? `Complete · ${dateOrMissing(employee.profileCompletedAt)}` : employee.profileOnboardingRequired ? "Required" : "Not requested"}</dd></div>
        </dl>
        {employee.user && (admin.role === "ADMIN" || (employee.user.role !== "ADMIN" && employee.user.role !== "HR_ADMINISTRATOR")) && <div className="border-t border-[var(--line)] px-5 py-4 sm:px-7"><EmployeeStatusForm employeeId={employee.user.id} isActive={employee.user.isActive} /></div>}
      </section>

      <section className="max-w-4xl space-y-5 rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm sm:p-7">
        <div><h2 className="text-base font-semibold">Personal profile</h2><p className="mt-1 text-xs text-[var(--muted)]">Profile contact email is separate from the account login email.</p></div>
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <div><dt className="text-xs text-[var(--muted)]">Contact email</dt><dd className="mt-1 text-sm font-medium">{valueOrMissing(employee.profile?.email)}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">Contact number</dt><dd className="mt-1 text-sm font-medium">{valueOrMissing(employee.profile?.contactNumber)}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">Date of birth</dt><dd className="mt-1 text-sm font-medium">{dateOrMissing(employee.profile?.dateOfBirth)}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">LinkedIn ID</dt><dd className="mt-1 text-sm font-medium">{valueOrMissing(employee.profile?.linkedInId)}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">Gender</dt><dd className="mt-1 text-sm font-medium">{genderLabel(employee.profile?.gender, employee.profile?.genderCustom)}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">Marital status</dt><dd className="mt-1 text-sm font-medium">{valueOrMissing(employee.profile?.maritalStatus)}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">Spouse</dt><dd className="mt-1 text-sm font-medium">{employee.profile?.spouseName || employee.profile?.spouseId ? `${employee.profile?.spouseName ?? "Not provided"} · ${employee.profile?.spouseId ?? "Not provided"}` : "Not provided"}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-[var(--muted)]">Permanent address</dt><dd className="mt-1 whitespace-pre-wrap text-sm font-medium">{valueOrMissing(employee.profile?.permanentAddress)}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-[var(--muted)]">Current address</dt><dd className="mt-1 whitespace-pre-wrap text-sm font-medium">{valueOrMissing(employee.profile?.currentAddress)}</dd></div>
        </dl>
        <div className="border-t border-[var(--line)] pt-4">
          <h3 className="text-sm font-semibold">Emergency contact</h3>
          <dl className="mt-3 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <div><dt className="text-xs text-[var(--muted)]">Name</dt><dd className="mt-1 text-sm">{valueOrMissing(employee.profile?.emergencyContactName)}</dd></div>
            <div><dt className="text-xs text-[var(--muted)]">ID</dt><dd className="mt-1 text-sm">{valueOrMissing(employee.profile?.emergencyContactId)}</dd></div>
            <div><dt className="text-xs text-[var(--muted)]">Phone</dt><dd className="mt-1 text-sm">{valueOrMissing(employee.profile?.emergencyContactPhone)}</dd></div>
            <div><dt className="text-xs text-[var(--muted)]">Relationship</dt><dd className="mt-1 text-sm">{valueOrMissing(employee.profile?.emergencyContactRelationship)}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-[var(--muted)]">Address</dt><dd className="mt-1 whitespace-pre-wrap text-sm">{valueOrMissing(employee.profile?.emergencyContactAddress)}</dd></div>
          </dl>
        </div>
        <div className="border-t border-[var(--line)] pt-4">
          <h3 className="text-sm font-semibold">Family</h3>
          <dl className="mt-3 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <div><dt className="text-xs text-[var(--muted)]">Mother</dt><dd className="mt-1 text-sm">{employee.profile?.motherName || employee.profile?.motherId || employee.profile?.motherContactNumber ? [employee.profile.motherName, employee.profile.motherId, employee.profile.motherContactNumber].filter(Boolean).join(" · ") : "Not provided"}</dd></div>
            <div><dt className="text-xs text-[var(--muted)]">Father</dt><dd className="mt-1 text-sm">{employee.profile?.fatherName || employee.profile?.fatherId || employee.profile?.fatherContactNumber ? [employee.profile.fatherName, employee.profile.fatherId, employee.profile.fatherContactNumber].filter(Boolean).join(" · ") : "Not provided"}</dd></div>
          </dl>
        </div>
      </section>
    </div>
  );
}