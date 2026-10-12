export default function DashboardLoading() {
  return (
    <section aria-label="Loading attendance dashboard" aria-busy="true" className="space-y-4">
      <div className="h-8 w-64 animate-pulse rounded bg-zinc-200" />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="h-24 animate-pulse rounded-lg border border-[var(--line)] bg-white" />
        <div className="h-24 animate-pulse rounded-lg border border-[var(--line)] bg-white" />
        <div className="h-24 animate-pulse rounded-lg border border-[var(--line)] bg-white" />
      </div>
      <div className="h-56 animate-pulse rounded-lg border border-[var(--line)] bg-white" />
    </section>
  );
}