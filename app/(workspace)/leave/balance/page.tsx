import { redirect } from "next/navigation";
import { hasPermission } from "@/lib/auth/permissions";
import { requirePageUser } from "@/lib/auth/session";
import { listOwnLeaveBalances } from "@/lib/leave/balance-service";

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

export default async function LeaveBalancePage() {
  const actor = await requirePageUser();
  if (actor.role !== "EMPLOYEE" || !hasPermission(actor.role, "leave:balance:self:read")) {
    redirect("/dashboard");
  }
  const entitlements = await listOwnLeaveBalances(actor);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium text-[var(--blue)]">Personal records</p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Leave balance</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">Your balance uses the configured period and approved scheduled workdays.</p>
      </header>

      {entitlements.length === 0 ? (
        <section role="status" className="rounded-lg border border-[var(--line)] bg-white px-4 py-8 text-center">
          <h2 className="text-base font-semibold">No active leave entitlement</h2>
          <p className="mt-2 text-sm text-[var(--muted)]">There is no leave entitlement configured for an active period. Contact HR if you think this is incorrect.</p>
        </section>
      ) : (
        <section aria-label="Active leave entitlements" className="grid gap-4 md:grid-cols-2">
          {entitlements.map((item) => (
            <article key={item.id} className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm">
              <div>
                <h2 className="text-base font-semibold">{item.leaveType.name}</h2>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Period: {dateOnly(item.periodStart)} – {dateOnly(item.periodEnd)}
                </p>
              </div>
              {item.balance.scheduleUnavailable && <p role="status" className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">Used leave and available balance are unavailable until your Shift has configured working days.</p>}
              {item.balance.scopedHolidaysUnresolved && <p role="status" className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">Some branch/group holidays could not be matched to you. The balance uses company-wide holidays and may not reflect those scoped dates.</p>}
              <dl className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <div>
                  <dt className="text-xs font-medium text-[var(--muted)]">Opening balance</dt>
                  <dd className="mt-1 text-lg font-semibold">{item.openingBalance.toString()}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-[var(--muted)]">Entitlement</dt>
                  <dd className="mt-1 text-lg font-semibold">{item.entitlement.toString()}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-[var(--muted)]">Carry forward</dt>
                  <dd className="mt-1 text-lg font-semibold">{item.carryForward.toString()}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-[var(--muted)]">Approved leave used</dt>
                  <dd className="mt-1 text-lg font-semibold">{item.balance.approvedLeaveUsed?.toString() ?? "Unavailable"}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-[var(--muted)]">Available balance</dt>
                  <dd className="mt-1 text-lg font-semibold">{item.balance.availableBalance?.toString() ?? "Unavailable"}</dd>
                </div>
              </dl>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
