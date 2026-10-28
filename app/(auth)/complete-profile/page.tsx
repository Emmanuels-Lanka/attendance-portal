import { redirect } from "next/navigation";
import { logoutAction } from "@/app/(auth)/logout/action";
import { getCurrentUser } from "@/lib/auth/session";
import { getEmployeeProfileOnboardingStatus } from "@/lib/employees/profile-service";
import { EmployeeProfileCompletionForm } from "./profile-form";

export default async function CompleteEmployeeProfilePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "ADMIN") redirect("/dashboard");

  const onboarding = await getEmployeeProfileOnboardingStatus(user.id);
  if (!onboarding.required) redirect("/dashboard");

  return (
    <main className="min-h-screen bg-slate-900 px-4 py-8 sm:px-8 sm:py-12">
      <section className="mx-auto w-full max-w-3xl rounded-xl border border-slate-200 bg-white px-5 py-7 shadow-xl sm:px-9 sm:py-9">
        <div className="mb-7 flex items-start justify-between gap-4 border-b border-slate-200 pb-5">
          <div>
          <p className="text-sm font-medium text-slate-600">Account onboarding</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">Complete your profile</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">Complete the required information to continue to your attendance workspace.</p>
          </div>
          <form action={logoutAction}>
            <button type="submit" className="shrink-0 rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Sign out</button>
          </form>
        </div>
        <EmployeeProfileCompletionForm contactEmail={user.email} username={user.username ?? ""} />
      </section>
    </main>
  );
}