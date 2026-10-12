export default function LeaveBalancesLoading() {
  return (
    <section aria-label="Loading leave balances" aria-busy="true" className="space-y-4">
      <div className="h-8 w-72 animate-pulse rounded bg-zinc-200" />
      <div className="h-24 animate-pulse rounded-lg border border-[var(--line)] bg-white" />
      <div className="h-64 animate-pulse rounded-lg border border-[var(--line)] bg-white" />
    </section>
  );
}