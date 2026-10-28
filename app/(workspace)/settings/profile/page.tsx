import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { EmployeeProfileCompletionForm } from "@/app/(auth)/complete-profile/profile-form";
import { requirePageUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export default async function EditProfilePage() {
  const user = await requirePageUser();
  const employee = await prisma.employee.findUnique({
    where: { userId: user.id },
    select: {
      profile: {
        select: {
          permanentAddress: true,
          currentAddress: true,
          emergencyContactName: true,
          emergencyContactId: true,
          emergencyContactAddress: true,
          emergencyContactPhone: true,
          emergencyContactRelationship: true,
          contactNumber: true,
          email: true,
          linkedInId: true,
          dateOfBirth: true,
          maritalStatus: true,
          spouseName: true,
          spouseId: true,
          motherName: true,
          motherId: true,
          motherContactNumber: true,
          fatherName: true,
          fatherId: true,
          fatherContactNumber: true,
          gender: true,
          genderCustom: true,
        },
      },
    },
  });
  if (!employee) notFound();

  const profile = employee.profile;
  const initialValues = {
    permanentAddress: profile?.permanentAddress ?? "",
    currentAddress: profile?.currentAddress ?? "",
    emergencyContactName: profile?.emergencyContactName ?? "",
    emergencyContactId: profile?.emergencyContactId ?? "",
    emergencyContactAddress: profile?.emergencyContactAddress ?? "",
    emergencyContactPhone: profile?.emergencyContactPhone ?? "",
    emergencyContactRelationship: profile?.emergencyContactRelationship ?? "",
    contactNumber: profile?.contactNumber ?? "",
    email: profile?.email ?? user.email,
    linkedInId: profile?.linkedInId ?? "",
    dateOfBirth: profile?.dateOfBirth?.toISOString().slice(0, 10) ?? "",
    maritalStatus: profile?.maritalStatus ?? "",
    spouseName: profile?.spouseName ?? "",
    spouseId: profile?.spouseId ?? "",
    motherName: profile?.motherName ?? "",
    motherId: profile?.motherId ?? "",
    motherContactNumber: profile?.motherContactNumber ?? "",
    fatherName: profile?.fatherName ?? "",
    fatherId: profile?.fatherId ?? "",
    fatherContactNumber: profile?.fatherContactNumber ?? "",
    gender: profile?.gender ?? "",
    genderCustom: profile?.genderCustom ?? "",
  };

  return (
    <div className="space-y-6">
      <div>
        <Link href="/settings" className="inline-flex items-center gap-1 text-sm font-medium text-[var(--muted)] hover:text-[var(--ink)]">
          <ChevronLeft size={16} aria-hidden="true" /> Settings
        </Link>
        <p className="mt-5 text-sm font-medium text-[var(--blue)]">Account</p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Edit profile</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">Update your username, contact details, and personal profile information.</p>
      </div>
      <section className="max-w-3xl rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm sm:p-7">
        <EmployeeProfileCompletionForm
          contactEmail={user.email}
          username={user.username ?? ""}
          mode="edit"
          initialValues={initialValues}
        />
      </section>
    </div>
  );
}
