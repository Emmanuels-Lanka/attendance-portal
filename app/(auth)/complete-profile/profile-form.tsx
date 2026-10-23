"use client";

import { useActionState } from "react";
import { useState } from "react";
import { completeEmployeeProfileAction } from "./actions";
import type { EmployeeProfileActionState } from "./actions";
import { employeeGenderValues } from "@/lib/employees/gender";

type ProfileField = {
  name: string;
  label: string;
  maxLength: number;
  required?: boolean;
  type?: "email" | "tel" | "date" | "text";
  multiline?: boolean;
};

const requiredFields: ProfileField[] = [
  { name: "permanentAddress", label: "Permanent address", maxLength: 2000, required: true, multiline: true },
  { name: "currentAddress", label: "Current address", maxLength: 2000, required: true, multiline: true },
  { name: "emergencyContactName", label: "Emergency contact name", maxLength: 120, required: true },
  { name: "emergencyContactId", label: "Emergency contact ID", maxLength: 120, required: true },
  { name: "emergencyContactAddress", label: "Emergency contact address", maxLength: 2000, required: true, multiline: true },
  { name: "emergencyContactPhone", label: "Emergency contact phone", maxLength: 64, required: true, type: "tel" },
  { name: "emergencyContactRelationship", label: "Emergency contact relationship", maxLength: 100, required: true },
  { name: "contactNumber", label: "Contact number", maxLength: 64, required: true, type: "tel" },
  { name: "email", label: "Contact email", maxLength: 254, required: true, type: "email" },
  { name: "linkedInId", label: "LinkedIn ID", maxLength: 512, required: true },
  { name: "dateOfBirth", label: "Date of birth", maxLength: 10, required: true, type: "date" },
  { name: "maritalStatus", label: "Marital status", maxLength: 50, required: true },
];

const spouseFields: ProfileField[] = [
  { name: "spouseName", label: "Spouse name", maxLength: 120 },
  { name: "spouseId", label: "Spouse ID", maxLength: 120 },
];

const motherFields: ProfileField[] = [
  { name: "motherName", label: "Mother name", maxLength: 120 },
  { name: "motherId", label: "Mother ID", maxLength: 120 },
  { name: "motherContactNumber", label: "Mother contact number", maxLength: 64, type: "tel" },
];

const fatherFields: ProfileField[] = [
  { name: "fatherName", label: "Father name", maxLength: 120 },
  { name: "fatherId", label: "Father ID", maxLength: 120 },
  { name: "fatherContactNumber", label: "Father contact number", maxLength: 64, type: "tel" },
];

function Field({ field, defaultValue }: { field: ProfileField; defaultValue?: string }) {
  const classes = "min-h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue)]";
  return (
    <div className={field.multiline ? "sm:col-span-2" : undefined}>
      <label htmlFor={field.name} className="mb-1.5 block text-sm font-semibold">{field.label}{field.required ? "" : " (optional)"}</label>
      {field.multiline ? (
        <textarea id={field.name} name={field.name} required={field.required} maxLength={field.maxLength} rows={3} defaultValue={defaultValue} className={classes} />
      ) : (
        <input id={field.name} name={field.name} type={field.type ?? "text"} required={field.required} maxLength={field.maxLength} defaultValue={defaultValue} className={classes} />
      )}
    </div>
  );
}

export function EmployeeProfileCompletionForm({ contactEmail }: { contactEmail: string }) {
  const [state, formAction, pending] = useActionState<EmployeeProfileActionState, FormData>(completeEmployeeProfileAction, null);
  const [gender, setGender] = useState("");
  const [genderCustom, setGenderCustom] = useState("");

  return (
    <form action={formAction} aria-busy={pending} className="space-y-7">
      <section className="space-y-4" aria-labelledby="contact-details-title">
        <h2 id="contact-details-title" className="text-base font-semibold">Contact and personal details</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {requiredFields.slice(0, 7).map((field) => <Field key={field.name} field={field} />)}
          {requiredFields.slice(7).map((field) => <Field key={field.name} field={field} defaultValue={field.name === "email" ? contactEmail : undefined} />)}
        </div>
        <p className="text-xs leading-5 text-[var(--muted)]">Contact email is stored on your employee profile; it does not change your sign-in email.</p>
      </section>

      <section className="space-y-4 border-t border-[var(--line)] pt-5" aria-labelledby="spouse-details-title">
        <div>
          <h2 id="spouse-details-title" className="text-base font-semibold">Spouse details</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">Both fields are optional.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">{spouseFields.map((field) => <Field key={field.name} field={field} />)}</div>
      </section>

      <section className="space-y-4 border-t border-[var(--line)] pt-5" aria-labelledby="gender-title">
        <div>
          <h2 id="gender-title" className="text-base font-semibold">Gender</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="gender" className="mb-1.5 block text-sm font-semibold">Gender</label>
            <select
              id="gender"
              name="gender"
              required
              value={gender}
              onChange={(event) => {
                setGender(event.target.value);
                if (event.target.value !== "CUSTOM") setGenderCustom("");
              }}
              className="min-h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue)]"
            >
              <option value="" disabled>Select an option</option>
              {employeeGenderValues.map((value) => (
                <option key={value} value={value}>
                  {value === "MALE" ? "Male" : value === "FEMALE" ? "Female" : value === "PREFER_NOT_TO_SAY" ? "Prefer Not to Say" : "Custom"}
                </option>
              ))}
            </select>
          </div>
          <div hidden={gender !== "CUSTOM"}>
            <label htmlFor="genderCustom" className="mb-1.5 block text-sm font-semibold">Specify your gender</label>
            <input
              id="genderCustom"
              name="genderCustom"
              type="text"
              maxLength={120}
              required={gender === "CUSTOM"}
              pattern=".*\S.*"
              title="Enter a nonblank custom gender."
              value={genderCustom}
              onChange={(event) => setGenderCustom(event.target.value)}
              className="min-h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--blue)]"
            />
          </div>
        </div>
      </section>

      <section className="space-y-4 border-t border-[var(--line)] pt-5" aria-labelledby="mother-details-title">
        <div>
          <h2 id="mother-details-title" className="text-base font-semibold">Mother details</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">At least one parent’s name and contact numbers are required; IDs are optional.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">{motherFields.map((field) => <Field key={field.name} field={field} />)}</div>
      </section>

      <section className="space-y-4 border-t border-[var(--line)] pt-5" aria-labelledby="father-details-title">
        <h2 id="father-details-title" className="text-base font-semibold">Father details</h2>
        <div className="grid gap-4 sm:grid-cols-2">{fatherFields.map((field) => <Field key={field.name} field={field} />)}</div>
      </section>

      {state?.error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{state.error}</p>}
      <button type="submit" disabled={pending} className="h-10 rounded-md bg-[var(--action)] px-5 text-sm font-semibold text-white transition hover:bg-[var(--action-hover)] disabled:opacity-60">
        {pending ? "Saving profile..." : "Complete profile"}
      </button>
    </form>
  );
}