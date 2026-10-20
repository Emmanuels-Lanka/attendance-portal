"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { completeEmployeeProfileForUser, EmployeeProfileCompletionError } from "@/lib/employees/profile-service";

export type EmployeeProfileActionState = { error: string } | null;

const profileFieldNames = [
  "permanentAddress",
  "currentAddress",
  "emergencyContactName",
  "emergencyContactId",
  "emergencyContactAddress",
  "emergencyContactPhone",
  "emergencyContactRelationship",
  "contactNumber",
  "email",
  "linkedInId",
  "dateOfBirth",
  "maritalStatus",
  "spouseName",
  "spouseId",
  "motherName",
  "motherId",
  "motherContactNumber",
  "fatherName",
  "fatherId",
  "fatherContactNumber",
] as const;

export async function completeEmployeeProfileAction(
  _previousState: EmployeeProfileActionState,
  formData: FormData,
): Promise<EmployeeProfileActionState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "ADMIN") redirect("/dashboard");

  const input = Object.fromEntries(profileFieldNames.map((field) => [field, formData.get(field)]));
  try {
    await completeEmployeeProfileForUser(user.id, input);
  } catch (error) {
    if (error instanceof EmployeeProfileCompletionError) redirect("/dashboard");
    if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? "Check the required profile details and try again." };
    return { error: "Your profile could not be saved. Try again shortly." };
  }

  redirect("/dashboard");
}