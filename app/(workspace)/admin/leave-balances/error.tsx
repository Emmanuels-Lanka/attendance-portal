"use client";

export default function LeaveBalancesError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section role="alert" className="rounded-lg border border-red-200 bg-white p-6">
      <h1 className="text-lg font-semibold">Leave entitlement data could not be loaded</h1>
      <p className="mt-2 text-sm text-[var(--muted)]">Try again. No leave entitlement data was changed.</p>
      <button type="button" onClick={reset} className="mt-4 h-10 rounded-md bg-[var(--action)] px-4 text-sm font-medium text-white">Retry</button>
    </section>
  );
}