import { z } from "zod";
import { isIanaTimeZone } from "@/lib/attendance/timezone";
import { passwordWithinBcryptLimit } from "@/lib/auth/password";
import { organizationAssignmentsSchema, organizationIdSchema } from "@/lib/organization/validation";
import { shiftIdSchema } from "@/lib/shifts/validation";
import { employeeGenderValues } from "@/lib/employees/gender";

const countryTimeZones: Record<string, string> = {
  LK: "Asia/Colombo",
  BD: "Asia/Dhaka",
};

export function isCountryCode(value: string) {
  if (!/^[A-Z]{2}$/.test(value)) return false;

  try {
    const regionName = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }).of(value);
    return regionName !== undefined && regionName !== "Unknown Region";
  } catch {
    return false;
  }
}

const employeeFields = {
  name: z.string().trim().min(1, "Name is required.").max(120),
  email: z.string().trim().email("Enter a valid email.").max(254).transform((value) => value.toLowerCase()),
  role: z.enum(["EMPLOYEE", "ADMIN", "HR_ADMINISTRATOR", "DEPARTMENT_MANAGER", "SUPERVISOR"]),
  countryCode: z.string().trim().toUpperCase().refine(isCountryCode, "Enter a valid two-letter country code."),
  timeZone: z.string().trim().refine(isIanaTimeZone, "Choose a valid IANA timezone."),
};

const usernamePattern = /^[a-z0-9._-]{3,30}$/;
const usernameMessage = "Username must be 3-30 characters using letters, numbers, periods, underscores, or hyphens.";
export const employeeUsernameSchema = z.string().trim().toLowerCase().regex(usernamePattern, usernameMessage);
const optionalUsernameSchema = z.preprocess(
  (value) => value === undefined ? undefined : value === null || typeof value === "string" && value.trim() === "" ? null : value,
  z.string().trim().toLowerCase().regex(usernamePattern, usernameMessage).nullable(),
).optional();

function optionalNullableText(maxLength: number) {
  return z.preprocess(
    (value) => value === undefined ? undefined : value === null ? null : value,
    z.string().trim().max(maxLength).nullable().transform((value) => value || null),
  ).optional();
}

const employeeIdentityFields = {
  nic: optionalNullableText(120),
  epfId: optionalNullableText(120),
  etfId: optionalNullableText(120),
};

const shiftAssignmentFields = {
  shiftIds: z.array(z.string().trim().min(1)).max(20).refine(
    (ids) => new Set(ids).size === ids.length,
    "Choose each shift only once.",
  ).optional(),
  shiftEffectiveFrom: z.preprocess(
    (value) => value === undefined || value === "" ? new Date().toISOString().slice(0, 10) : value,
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }, "Enter a valid shift assignment start date."),
  ).refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Enter a valid shift assignment start date.")
    .transform((value) => new Date(`${value}T00:00:00.000Z`)),
};

const profileDateField = z.preprocess(
  (value) => value === undefined ? undefined : value === null || value === "" ? null : value,
  z.union([
    z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      return Number.isFinite(date.getTime())
        && date.toISOString().slice(0, 10) === value
        && value <= new Date().toISOString().slice(0, 10);
    }, "Enter a valid date."),
    z.null(),
  ]),
).transform((value) => value === null ? null : new Date(`${value}T00:00:00.000Z`)).optional();

export const adminEmployeeProfilePatchSchema = z.object({
  permanentAddress: optionalNullableText(2000),
  currentAddress: optionalNullableText(2000),
  emergencyContactName: optionalNullableText(120),
  emergencyContactId: optionalNullableText(120),
  emergencyContactAddress: optionalNullableText(2000),
  emergencyContactPhone: optionalNullableText(64),
  emergencyContactRelationship: optionalNullableText(100),
  contactNumber: optionalNullableText(64),
  email: z.preprocess(
    (value) => value === undefined ? undefined : value === null ? null : typeof value === "string" && value.trim() === "" ? null : value,
    z.string().trim().email("Enter a valid profile contact email.").max(254).transform((value) => value.toLowerCase()).nullable(),
  ).optional(),
  linkedInId: optionalNullableText(512),
  dateOfBirth: profileDateField,
  maritalStatus: optionalNullableText(50),
  spouseName: optionalNullableText(120),
  spouseId: optionalNullableText(120),
  motherName: optionalNullableText(120),
  motherId: optionalNullableText(120),
  motherContactNumber: optionalNullableText(64),
  fatherName: optionalNullableText(120),
  fatherId: optionalNullableText(120),
  fatherContactNumber: optionalNullableText(64),
  gender: z.preprocess(
    (value) => value === undefined ? undefined : value === null || typeof value === "string" && value.trim() === "" ? null : value,
    z.enum(employeeGenderValues).nullable(),
  ).optional(),
  genderCustom: optionalNullableText(120),
}).superRefine((profile, context) => {
  if (profile.gender === "CUSTOM" && profile.genderCustom == null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["genderCustom"],
      message: "Specify a custom gender value.",
    });
  }
  if (profile.gender !== "CUSTOM" && profile.genderCustom != null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["genderCustom"],
      message: "Custom gender text is only allowed when gender is Custom.",
    });
  }
});

export type AdminEmployeeProfilePatch = z.infer<typeof adminEmployeeProfilePatchSchema>;

function validateLocation(countryCode: string, timeZone: string, context: z.RefinementCtx) {
  const requiredTimeZone = countryTimeZones[countryCode];
  if (requiredTimeZone && timeZone !== requiredTimeZone) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["timeZone"],
      message: `${countryCode} employees must use ${requiredTimeZone}.`,
    });
  }
}

export const createEmployeeSchema = z.object({
  ...employeeFields,
  username: employeeUsernameSchema,
  employeeCode: z.string().trim().min(1, "Employee ID is required.").max(50),
  ...employeeIdentityFields,
  ...organizationAssignmentsSchema,
  ...shiftAssignmentFields,
  supervisorId: organizationIdSchema,
  managerId: organizationIdSchema,
  shiftId: shiftIdSchema,
  password: z.string().min(1, "An initial password is required.").refine(passwordWithinBcryptLimit, "Password must not exceed 72 UTF-8 bytes."),
}).superRefine(({ countryCode, timeZone }, context) => validateLocation(countryCode, timeZone, context));

export const updateEmployeeSchema = z.object({
  ...employeeFields,
  username: optionalUsernameSchema,
  employeeCode: optionalNullableText(50),
  ...employeeIdentityFields,
  ...organizationAssignmentsSchema,
  ...shiftAssignmentFields,
  supervisorId: organizationIdSchema,
  managerId: organizationIdSchema,
  shiftId: shiftIdSchema,
  password: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().refine(passwordWithinBcryptLimit, "Password must not exceed 72 UTF-8 bytes.").optional(),
  ),
  profile: adminEmployeeProfilePatchSchema.optional(),
}).superRefine(({ countryCode, timeZone }, context) => validateLocation(countryCode, timeZone, context));

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;