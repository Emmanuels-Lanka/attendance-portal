import "server-only";

import type { Prisma, PrismaClient, Role } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { employeeProfileRequiredFields } from "@/lib/employees/profile-requirements";
import { employeeGenderValues } from "@/lib/employees/gender";

function nullableText(maxLength: number) {
  return z.preprocess(
    (value) => typeof value === "string" ? value : "",
    z.string().trim().max(maxLength).transform((value) => value || null),
  );
}

function isValidDateOnly(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const dateOfBirthSchema = z.string()
  .trim()
  .refine(isValidDateOnly, "Enter a valid date of birth.")
  .refine((value) => value <= new Date().toISOString().slice(0, 10), "Date of birth cannot be in the future.")
  .transform((value) => new Date(`${value}T00:00:00.000Z`));

const optionalGenderSchema = nullableText(32).refine(
  (value) => value === null || employeeGenderValues.some((choice) => choice === value),
  "Choose a valid gender option.",
);

export const employeeProfileCompletionSchema = z.object({
  permanentAddress: z.string().trim().min(1, "Permanent address is required.").max(2000),
  currentAddress: z.string().trim().min(1, "Current address is required.").max(2000),
  emergencyContactName: z.string().trim().min(1, "Emergency contact name is required.").max(120),
  emergencyContactId: z.string().trim().min(1, "Emergency contact ID is required.").max(120),
  emergencyContactAddress: z.string().trim().min(1, "Emergency contact address is required.").max(2000),
  emergencyContactPhone: z.string().trim().min(1, "Emergency contact phone is required.").max(64),
  emergencyContactRelationship: z.string().trim().min(1, "Emergency contact relationship is required.").max(100),
  contactNumber: z.string().trim().min(1, "Contact number is required.").max(64),
  email: z.string().trim().email("Enter a valid contact email.").max(254).transform((value) => value.toLowerCase()),
  linkedInId: z.string().trim().min(1, "LinkedIn ID is required.").max(512),
  dateOfBirth: dateOfBirthSchema,
  maritalStatus: z.string().trim().min(1, "Marital status is required.").max(50),
  spouseName: nullableText(120),
  spouseId: nullableText(120),
  motherName: nullableText(120),
  motherId: nullableText(120),
  motherContactNumber: nullableText(64),
  fatherName: nullableText(120),
  fatherId: nullableText(120),
  fatherContactNumber: nullableText(64),
  gender: optionalGenderSchema,
  genderCustom: nullableText(120),
}).superRefine((profile, context) => {
  for (const field of employeeProfileRequiredFields) {
    if (profile[field] === null || profile[field] === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required.` });
    }
  }

  const motherComplete = profile.motherName !== null && profile.motherId !== null;
  const fatherComplete = profile.fatherName !== null && profile.fatherId !== null;
  const motherHasAnyValue = profile.motherName !== null || profile.motherId !== null || profile.motherContactNumber !== null;
  const fatherHasAnyValue = profile.fatherName !== null || profile.fatherId !== null || profile.fatherContactNumber !== null;

  if (motherHasAnyValue && !motherComplete) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["motherName"],
      message: "Enter both the mother's name and ID, or leave all mother details blank.",
    });
  }
  if (fatherHasAnyValue && !fatherComplete) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fatherName"],
      message: "Enter both the father's name and ID, or leave all father details blank.",
    });
  }
  if (!motherComplete && !fatherComplete) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["motherName"],
      message: "Provide both the name and ID for at least one parent.",
    });
  }
  if (profile.gender === "CUSTOM" && profile.genderCustom === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["genderCustom"],
      message: "Specify your gender when selecting Custom.",
    });
  }
  if (profile.gender !== "CUSTOM" && profile.genderCustom !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["genderCustom"],
      message: "Custom gender text is only allowed when selecting Custom.",
    });
  }
});

type ProfileStatusDatabase = Pick<PrismaClient, "employee">;
type EmployeeProfileDatabase = Pick<PrismaClient, "employee" | "employeeProfile" | "attendanceAuditLog" | "$transaction">;
type ProfileTransaction = Prisma.TransactionClient;

export class EmployeeProfileCompletionError extends Error {
  constructor() {
    super("This account is not eligible for profile completion.");
    this.name = "EmployeeProfileCompletionError";
  }
}

export async function getEmployeeProfileOnboardingStatus(userId: string, database: ProfileStatusDatabase = prisma) {
  const employee = await database.employee.findUnique({
    where: { userId },
    select: { profileOnboardingRequired: true, profileCompletedAt: true },
  });

  return {
    required: employee?.profileOnboardingRequired === true && employee.profileCompletedAt === null,
    completedAt: employee?.profileCompletedAt ?? null,
  };
}

export function requiresProfileCompletion(role: Role, onboardingRequired: boolean) {
  return role !== "ADMIN" && onboardingRequired;
}

export async function completeEmployeeProfileForUser(
  userId: string,
  input: unknown,
  database: EmployeeProfileDatabase = prisma,
  completedAt = new Date(),
) {
  const profile = employeeProfileCompletionSchema.parse(input);

  return database.$transaction(async (transaction) => {
    const employee = await transaction.employee.findUnique({
      where: { userId },
      select: { id: true, profileOnboardingRequired: true, profileCompletedAt: true },
    });
    if (!employee || !employee.profileOnboardingRequired || employee.profileCompletedAt) {
      throw new EmployeeProfileCompletionError();
    }

    await transaction.employeeProfile.upsert({
      where: { employeeRecordId: employee.id },
      create: { employeeRecordId: employee.id, ...profile },
      update: profile,
      select: { employeeRecordId: true },
    });

    const completion = await transaction.employee.updateMany({
      where: { id: employee.id, userId, profileOnboardingRequired: true, profileCompletedAt: null },
      data: { profileCompletedAt: completedAt, profileOnboardingRequired: false },
    });
    if (completion.count !== 1) throw new EmployeeProfileCompletionError();

    await transaction.attendanceAuditLog.create({
      data: { employeeId: userId, actorId: userId, actionType: "EMPLOYEE_PROFILE_COMPLETED" },
      select: { id: true },
    });

    return { profileCompletedAt: completedAt };
  });
}

export type EmployeeProfileTransactionForTests = ProfileTransaction;