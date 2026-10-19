"use client";

import { useActionState } from "react";
import { KeyRound, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { loginAction } from "./actions";

export function LoginForm({ passwordResetCompleted = false }: { passwordResetCompleted?: boolean }) {
  const [state, formAction, pending] = useActionState(loginAction, null);

  return (
    <form action={formAction} aria-busy={pending} className="mt-6 w-full space-y-6">
      <div>
        <label htmlFor="username" className="mb-2 block text-base font-medium text-slate-700">Username</label>
        <input
          id="username"
          name="identifier"
          type="text"
          autoComplete="username"
          required
          maxLength={254}
          className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 ring-offset-white transition placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="Enter your username"
        />
      </div>
      <div>
        <label htmlFor="password" className="mb-2 block text-base font-medium text-slate-700">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 ring-offset-white transition placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="Enter your password"
        />
      </div>
      {passwordResetCompleted && <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Your password has been reset. Sign in with your new password.</p>}
      {state?.error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-4 text-base font-medium text-white transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-50"
      >
        <span>{pending ? "Signing in..." : "Sign in"}</span>
        {pending ? <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> : <KeyRound size={18} aria-hidden="true" />}
      </button>
      <div className="text-center text-sm">
        <Link href="/forgot-password" className="font-medium text-slate-700 underline-offset-4 hover:underline">Forgot password?</Link>
      </div>
    </form>
  );
}