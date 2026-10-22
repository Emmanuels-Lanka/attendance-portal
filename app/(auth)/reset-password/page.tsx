import Link from "next/link";
import Image from "next/image";
import { ResetPasswordForm } from "./reset-password-form";
import { isPasswordResetTokenValid, passwordResetTokenMessage } from "@/lib/auth/password-reset";
import { getCompanyName } from "@/lib/attendance/settings";

export const metadata = { referrer: "no-referrer", robots: { index: false, follow: false } };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const valid = await isPasswordResetTokenValid(token);
  const companyName = await getCompanyName();

  return (
    <main className="flex min-h-screen flex-col bg-slate-900">
      <div className="flex flex-1 items-center justify-center px-4 py-8 sm:px-8 sm:py-12">
        <section className="w-full max-w-xl rounded-xl border border-slate-200 bg-white px-6 py-7 shadow-xl sm:px-10 sm:py-9">
          <div className="mb-6 flex flex-col items-center text-center">
            <Image src="/eml-company-logo.png" alt={companyName} width={768} height={768} priority className="mb-3 size-16 object-contain" />
            <p className="text-sm font-semibold text-slate-900">EML – Attendance Management System</p>
            <p className="mt-1 text-xs text-slate-600">{companyName}</p>
            <h1 className="text-lg font-semibold text-slate-900">Reset password</h1>
            <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">Choose a new password for your account.</p>
          </div>
          {valid && token
            ? <ResetPasswordForm token={token} />
            : <div className="space-y-4 text-center"><p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{passwordResetTokenMessage}</p><Link href="/forgot-password" className="inline-block text-sm font-medium text-slate-700 underline-offset-4 hover:underline">Request a new reset link</Link></div>}
        </section>
      </div>
    </main>
  );
}