"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import {
  EmployeeProfileCompletionError,
  EmployeeProfileUsernameConflictError,
  updateEmployeeProfileForUser,
} from "@/lib/employees/profile-service";
import type { EmployeeProfileActionState } from "@/app/(auth)/complete-profile/actions";

const profileFieldNames = [
  "username",
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
  "gender",
  "genderCustom",
] as const;

export async function saveEmployeeProfileAction(
  _previousState: EmployeeProfileActionState,
  formData: FormData,
): Promise<EmployeeProfileActionState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const input = Object.fromEntries(profileFieldNames.map((field) => [field, formData.get(field)]));
  try {
    await updateEmployeeProfileForUser(user.id, input);
  } catch (error) {
    if (error instanceof EmployeeProfileUsernameConflictError) return { error: error.message };
    if (error instanceof EmployeeProfileCompletionError) return { error: "Your employee profile could not be found." };
    if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? "Check your profile details and try again." };
    console.error("Employee profile update failed", error instanceof Error ? error.name : "Unknown error");
    return { error: "Your profile could not be saved. Try again shortly." };
  }

  revalidatePath("/settings");
  revalidatePath("/settings/profile");
  revalidatePath("/admin/employees");
  redirect("/settings");
}
