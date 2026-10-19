import Link from "next/link";
import Image from "next/image";
import { ForgotPasswordForm } from "./forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-screen flex-col bg-slate-900">
      <div className="flex flex-1 items-center justify-center px-4 py-8 sm:px-8 sm:py-12">
        <section className="w-full max-w-xl rounded-xl border border-slate-200 bg-white px-6 py-7 shadow-xl sm:px-10 sm:py-9">
          <div className="mb-6 flex flex-col items-center text-center">
            <Image src="/eml-company-logo.png" alt="Emmanuel's Lanka Pvt Ltd" width={768} height={768} priority className="mb-3 size-16 object-contain" />
            <p className="text-sm font-semibold text-slate-900">EML – Attendance Management System</p>
            <p className="mt-1 text-xs text-slate-600">Emmanuel&apos;s Lanka Pvt Ltd</p>
            <h1 className="text-lg font-semibold text-slate-900">Forgot password</h1>
            <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">Enter the email address for your account.</p>
          </div>
          <ForgotPasswordForm />
          <p className="mt-5 text-center text-sm"><Link href="/login" className="font-medium text-slate-700 underline-offset-4 hover:underline">Back to sign in</Link></p>
        </section>
      </div>
    </main>
  );
}