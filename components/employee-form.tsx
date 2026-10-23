"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useState } from "react";
import { createEmployeeAction, updateEmployeeAction } from "@/app/(workspace)/admin/employees/actions";
import type { EmployeeActionState } from "@/app/(workspace)/admin/employees/actions";
import type { Role } from "@prisma/client";
import { employeeGenderValues } from "@/lib/employees/gender";

type EmployeeFormValues = {
  id: string;
  name: string;
  employeeCode: string | null;
  nic: string | null;
  epfId: string | null;
  etfId: string | null;
  departmentId: string | null;
  designationId: string | null;
  shiftId: string | null;
  shiftIds?: string[];
  supervisorId: string | null;
  managerId: string | null;
  email: string;
  username: string | null;
  role: Role;
  countryCode: string;
  timeZone: string;
  profile: {
    permanentAddress: string | null;
    currentAddress: string | null;
    emergencyContactName: string | null;
    emergencyContactId: string | null;
    emergencyContactAddress: string | null;
    emergencyContactPhone: string | null;
    emergencyContactRelationship: string | null;
    contactNumber: string | null;
    email: string | null;
    linkedInId: string | null;
    dateOfBirth: Date | null;
    maritalStatus: string | null;
    spouseName: string | null;
    spouseId: string | null;
    motherName: string | null;
    motherId: string | null;
    motherContactNumber: string | null;
    fatherName: string | null;
    fatherId: string | null;
    fatherContactNumber: string | null;
    gender: string | null;
    genderCustom: string | null;
  } | null;
};

type OrganizationOption = { id: string; name: string };

export function EmployeeForm({
  employee,
  canManageAdministratorRoles = true,
  defaultTimeZone = "Asia/Colombo",
  departments,
  designations,
  shifts,
  supervisors,
  managers,
}: {
  employee?: EmployeeFormValues;
  canManageAdministratorRoles?: boolean;
  defaultTimeZone?: string;
  departments: OrganizationOption[];
  designations: OrganizationOption[];
  shifts: OrganizationOption[];
  supervisors: OrganizationOption[];
  managers: OrganizationOption[];
}) {
  const boundUpdateAction = employee ? updateEmployeeAction.bind(null, employee.id) : createEmployeeAction;
  const [state, formAction, pending] = useActionState<EmployeeActionState, FormData>(boundUpdateAction, null);
  const [gender, setGender] = useState(employee?.profile?.gender ?? "");
  const [genderCustom, setGenderCustom] = useState(employee?.profile?.genderCustom ?? "");

  return (
    <form action={formAction} className="max-w-4xl space-y-5 rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm sm:p-7">
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="name" className="mb-2 block text-sm font-semibold">Full name</label>
          <input id="name" name="name" required maxLength={120} defaultValue={employee?.name} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
        </div>
        <div>
          <label htmlFor="employeeCode" className="mb-2 block text-sm font-semibold">Employee ID</label>
          <input id="employeeCode" name="employeeCode" required={!employee} maxLength={50} defaultValue={employee?.employeeCode ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
        </div>
        <div>
          <label htmlFor="departmentId" className="mb-2 block text-sm font-semibold">Department</label>
          <select id="departmentId" name="departmentId" defaultValue={employee?.departmentId ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm">
            <option value="">Unassigned</option>
            {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="designationId" className="mb-2 block text-sm font-semibold">Designation</label>
          <select id="designationId" name="designationId" defaultValue={employee?.designationId ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm">
            <option value="">Unassigned</option>
            {designations.map((designation) => <option key={designation.id} value={designation.id}>{designation.name}</option>)}
          </select>
        </div>
        <div>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-semibold">Shift assignments</legend>
            <p className="text-xs text-[var(--muted)]">Choose shifts with non-overlapping working days. Existing assignments remain in attendance history.</p>
            <input type="hidden" name="shiftAssignmentsSubmitted" value="true" />
            {shifts.length === 0 ? <p className="text-sm text-[var(--muted)]">No shifts are configured.</p> : shifts.map((shift) => (
              <label key={shift.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="shiftIds"
                  value={shift.id}
                  defaultChecked={employee?.shiftIds?.includes(shift.id) ?? employee?.shiftId === shift.id}
                  className="size-4 rounded border-[var(--line)]"
                />
                {shift.name}
              </label>
            ))}
            <label htmlFor="shiftEffectiveFrom" className="mt-3 block text-xs font-medium">Effective from</label>
            <input id="shiftEffectiveFrom" name="shiftEffectiveFrom" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
          </fieldset>
        </div>
        <div>
          <label htmlFor="supervisorId" className="mb-2 block text-sm font-semibold">Supervisor</label>
          <select id="supervisorId" name="supervisorId" defaultValue={employee?.supervisorId ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm">
            <option value="">Unassigned</option>
            {supervisors.map((supervisor) => <option key={supervisor.id} value={supervisor.id}>{supervisor.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="managerId" className="mb-2 block text-sm font-semibold">Department Manager</label>
          <select id="managerId" name="managerId" defaultValue={employee?.managerId ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm">
            <option value="">Unassigned</option>
            {managers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="nic" className="mb-2 block text-sm font-semibold">NIC</label>
          <input id="nic" name="nic" maxLength={120} defaultValue={employee?.nic ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
        </div>
        <div>
          <label htmlFor="epfId" className="mb-2 block text-sm font-semibold">EPF number</label>
          <input id="epfId" name="epfId" maxLength={120} defaultValue={employee?.epfId ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
        </div>
        <div>
          <label htmlFor="etfId" className="mb-2 block text-sm font-semibold">ETF number</label>
          <input id="etfId" name="etfId" maxLength={120} defaultValue={employee?.etfId ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
        </div>
        <div>
          <label htmlFor="email" className="mb-2 block text-sm font-semibold">Login email</label>
          <input id="email" name="email" type="email" autoComplete="email" required maxLength={254} defaultValue={employee?.email} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
        </div>
        <div>
          <label htmlFor="username" className="mb-2 block text-sm font-semibold">Username</label>
          <input id="username" name="username" autoComplete="username" autoCapitalize="none" required={!employee} minLength={3} maxLength={30} pattern="[A-Za-z0-9._-]{3,30}" defaultValue={employee?.username ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
        </div>
        <div>
          <label htmlFor="countryCode" className="mb-2 block text-sm font-semibold">Country code</label>
          <input id="countryCode" name="countryCode" required minLength={2} maxLength={2} pattern="[A-Za-z]{2}" autoCapitalize="characters" placeholder="LK" defaultValue={employee?.countryCode} onChange={(event) => {
            const timezone = document.getElementById("timeZone");
            if (!(timezone instanceof HTMLInputElement) || employee) return;
            const country = event.currentTarget.value.trim().toUpperCase();
            timezone.value = country === "LK" ? "Asia/Colombo" : country === "BD" ? "Asia/Dhaka" : defaultTimeZone;
          }} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm uppercase" />
        </div>
        <div>
          <label htmlFor="timeZone" className="mb-2 block text-sm font-semibold">IANA timezone</label>
          <input id="timeZone" name="timeZone" required placeholder="Asia/Colombo" defaultValue={employee?.timeZone ?? defaultTimeZone} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
        </div>
        <div>
          <label htmlFor="role" className="mb-2 block text-sm font-semibold">Role</label>
          <select id="role" name="role" required defaultValue={employee?.role ?? "EMPLOYEE"} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm">
            <option value="EMPLOYEE">Employee</option>
            <option value="SUPERVISOR">Supervisor</option>
            <option value="DEPARTMENT_MANAGER">Department Manager</option>
            {canManageAdministratorRoles && <option value="HR_ADMINISTRATOR">HR Administrator</option>}
            {canManageAdministratorRoles && <option value="ADMIN">Super Administrator</option>}
          </select>
        </div>
        <div>
          <label htmlFor="password" className="mb-2 block text-sm font-semibold">{employee ? "Reset password" : "Initial password"}</label>
          <input id="password" name="password" type="password" autoComplete="new-password" required={!employee} minLength={1} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
          <p className="mt-1.5 text-xs text-[var(--muted)]">{employee ? "Leave blank to keep the current password." : "Maximum 72 UTF-8 bytes."}</p>
        </div>
      </div>
      {employee && (
        <div className="space-y-5 border-t border-[var(--line)] pt-5">
          <div>
            <h2 className="text-base font-semibold">Personal profile</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">Contact email is separate from the account login email. Blank fields can be cleared.</p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label htmlFor="profileEmail" className="mb-2 block text-sm font-semibold">Profile contact email</label>
              <input id="profileEmail" name="profileEmail" type="email" maxLength={254} defaultValue={employee.profile?.email ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div>
              <label htmlFor="dateOfBirth" className="mb-2 block text-sm font-semibold">Date of birth</label>
              <input id="dateOfBirth" name="dateOfBirth" type="date" defaultValue={employee.profile?.dateOfBirth?.toISOString().slice(0, 10) ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="permanentAddress" className="mb-2 block text-sm font-semibold">Permanent address</label>
              <textarea id="permanentAddress" name="permanentAddress" maxLength={2000} rows={3} defaultValue={employee.profile?.permanentAddress ?? ""} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm" />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="currentAddress" className="mb-2 block text-sm font-semibold">Current address</label>
              <textarea id="currentAddress" name="currentAddress" maxLength={2000} rows={3} defaultValue={employee.profile?.currentAddress ?? ""} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm" />
            </div>
            <div>
              <label htmlFor="contactNumber" className="mb-2 block text-sm font-semibold">Contact number</label>
              <input id="contactNumber" name="contactNumber" type="tel" maxLength={64} defaultValue={employee.profile?.contactNumber ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div>
              <label htmlFor="linkedInId" className="mb-2 block text-sm font-semibold">LinkedIn ID</label>
              <input id="linkedInId" name="linkedInId" maxLength={512} defaultValue={employee.profile?.linkedInId ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div>
              <label htmlFor="maritalStatus" className="mb-2 block text-sm font-semibold">Marital status</label>
              <input id="maritalStatus" name="maritalStatus" maxLength={50} defaultValue={employee.profile?.maritalStatus ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div>
              <label htmlFor="gender" className="mb-2 block text-sm font-semibold">Gender</label>
              <select
                id="gender"
                name="gender"
                value={gender}
                onChange={(event) => {
                  setGender(event.target.value);
                  if (event.target.value !== "CUSTOM") setGenderCustom("");
                }}
                className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm"
              >
                <option value="">Not provided</option>
                {employeeGenderValues.map((value) => (
                  <option key={value} value={value}>
                    {value === "MALE" ? "Male" : value === "FEMALE" ? "Female" : value === "PREFER_NOT_TO_SAY" ? "Prefer Not to Say" : "Custom"}
                  </option>
                ))}
              </select>
            </div>
            <div hidden={gender !== "CUSTOM"}>
              <label htmlFor="genderCustom" className="mb-2 block text-sm font-semibold">Specify gender</label>
              <input
                id="genderCustom"
                name="genderCustom"
                maxLength={120}
                required={gender === "CUSTOM"}
                value={genderCustom}
                onChange={(event) => setGenderCustom(event.target.value)}
                className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm"
              />
            </div>
            <div>
              <label htmlFor="spouseName" className="mb-2 block text-sm font-semibold">Spouse name</label>
              <input id="spouseName" name="spouseName" maxLength={120} defaultValue={employee.profile?.spouseName ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div>
              <label htmlFor="spouseId" className="mb-2 block text-sm font-semibold">Spouse ID</label>
              <input id="spouseId" name="spouseId" maxLength={120} defaultValue={employee.profile?.spouseId ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div>
              <label htmlFor="emergencyContactName" className="mb-2 block text-sm font-semibold">Emergency contact name</label>
              <input id="emergencyContactName" name="emergencyContactName" maxLength={120} defaultValue={employee.profile?.emergencyContactName ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div>
              <label htmlFor="emergencyContactId" className="mb-2 block text-sm font-semibold">Emergency contact ID</label>
              <input id="emergencyContactId" name="emergencyContactId" maxLength={120} defaultValue={employee.profile?.emergencyContactId ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="emergencyContactAddress" className="mb-2 block text-sm font-semibold">Emergency contact address</label>
              <textarea id="emergencyContactAddress" name="emergencyContactAddress" maxLength={2000} rows={3} defaultValue={employee.profile?.emergencyContactAddress ?? ""} className="w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm" />
            </div>
            <div>
              <label htmlFor="emergencyContactPhone" className="mb-2 block text-sm font-semibold">Emergency contact phone</label>
              <input id="emergencyContactPhone" name="emergencyContactPhone" type="tel" maxLength={64} defaultValue={employee.profile?.emergencyContactPhone ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div>
              <label htmlFor="emergencyContactRelationship" className="mb-2 block text-sm font-semibold">Emergency contact relationship</label>
              <input id="emergencyContactRelationship" name="emergencyContactRelationship" maxLength={100} defaultValue={employee.profile?.emergencyContactRelationship ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div>
              <label htmlFor="motherName" className="mb-2 block text-sm font-semibold">Mother name</label>
              <input id="motherName" name="motherName" maxLength={120} defaultValue={employee.profile?.motherName ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div>
              <label htmlFor="motherId" className="mb-2 block text-sm font-semibold">Mother ID</label>
              <input id="motherId" name="motherId" maxLength={120} defaultValue={employee.profile?.motherId ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div>
              <label htmlFor="motherContactNumber" className="mb-2 block text-sm font-semibold">Mother contact number</label>
              <input id="motherContactNumber" name="motherContactNumber" type="tel" maxLength={64} defaultValue={employee.profile?.motherContactNumber ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div>
              <label htmlFor="fatherName" className="mb-2 block text-sm font-semibold">Father name</label>
              <input id="fatherName" name="fatherName" maxLength={120} defaultValue={employee.profile?.fatherName ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div>
              <label htmlFor="fatherId" className="mb-2 block text-sm font-semibold">Father ID</label>
              <input id="fatherId" name="fatherId" maxLength={120} defaultValue={employee.profile?.fatherId ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
            <div>
              <label htmlFor="fatherContactNumber" className="mb-2 block text-sm font-semibold">Father contact number</label>
              <input id="fatherContactNumber" name="fatherContactNumber" type="tel" maxLength={64} defaultValue={employee.profile?.fatherContactNumber ?? ""} className="h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm" />
            </div>
          </div>
        </div>
      )}
      {state?.error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-[var(--danger)]">{state.error}</p>}
      <div className="flex flex-wrap gap-3 border-t border-[var(--line)] pt-5">
        <button type="submit" disabled={pending} className="h-10 rounded-md bg-[var(--action)] px-4 text-sm font-medium text-white transition hover:bg-[var(--action-hover)] disabled:opacity-60">{pending ? "Saving..." : employee ? "Save changes" : "Create employee"}</button>
        <Link href={employee ? `/admin/employees/${employee.id}` : "/admin/employees"} className="inline-flex h-10 items-center rounded-md border border-[var(--line)] bg-white px-4 text-sm font-medium hover:bg-zinc-50">Cancel</Link>
      </div>
    </form>
  );
}