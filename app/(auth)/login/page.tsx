import { redirect } from "next/navigation";
import Image from "next/image";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ passwordReset?: string }> }) {
  if (await getCurrentUser()) redirect("/dashboard");
  const params = await searchParams;

  return (
    <main className="flex min-h-screen flex-col bg-slate-900">
      <div className="flex flex-1 items-center justify-center px-4 py-8 sm:px-8 sm:py-12">
        <section className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white px-6 py-7 shadow-xl sm:px-12 sm:py-10">
          <div className="mb-7 flex flex-col items-center justify-center text-center">
            <Image src="/eml-company-logo.png" alt="Emmanuel's Lanka Pvt Ltd" width={768} height={768} priority className="mb-3 size-24 object-contain" />
            <h1 className="text-lg font-medium text-slate-900">EML – Attendance Management System</h1>
            <p className="mt-1 text-sm font-medium text-slate-600">Emmanuel&apos;s Lanka Pvt Ltd</p>
            <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">Sign in to view your attendance records and work sessions.</p>
          </div>
          <div className="border-t border-slate-200" />
          <LoginForm passwordResetCompleted={params.passwordReset === "success"} />
        </section>
      </div>
      <footer className="flex min-h-[50px] flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs text-slate-300 sm:px-6">
        <p className="font-medium">Emmanuel&apos;s Lanka Pvt Ltd</p>
      </footer>
    </main>
  );
}