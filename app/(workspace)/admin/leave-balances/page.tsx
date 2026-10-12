import { LeaveEntitlementForm } from "@/components/leave-entitlement-form";
import { requirePagePermission } from "@/lib/auth/session";
import {
  getManagedLeaveBalance,
  listLeaveEntitlementEmployees,
  listLeaveTypesForEntitlements,
} from "@/lib/leave/balance-service";
import { leaveEntitlementLookupSchema } from "@/lib/leave/validation";

type SearchParams = {
  employeeId?: string | string[];
  leaveTypeId?: string | string[];
  periodStart?: string | string[];
  periodEnd?: string | string[];
};

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

export default async function LeaveBalancesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const actor = await requirePagePermission("leave:manage");
  const params = await searchParams;
  const selected = {
    employeeId: single(params.employeeId),
    leaveTypeId: single(params.leaveTypeId),
    periodStart: single(params.periodStart),
    periodEnd: single(params.periodEnd),
  };
  const [employees, leaveTypes] = await Promise.all([
    listLeaveEntitlementEmployees(actor),
    listLeaveTypesForEntitlements(actor),
  ]);

  const hasLookup = Object.values(selected).some(Boolean);
  const parsedLookup = hasLookup ? leaveEntitlementLookupSchema.safeParse(selected) : null;
  const lookupError = parsedLookup && !parsedLookup.success
    ? parsedLookup.error.issues[0]?.message ?? "Choose an employee, Leave Type, and valid period."
    : null;
  const result = parsedLookup?.success
    ? await getManagedLeaveBalance(actor, parsedLookup.data)
    : null;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium text-[var(--blue)]">HR administration</p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Leave entitlements and balances</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">Balances use the configured period and approved scheduled workdays.</p>
      </header>

      <form method="get" className="grid gap-3 rounded-lg border border-[var(--line)] bg-white p-4 sm:grid-cols-2 xl:grid-cols-5 xl:items-end">
        <label className="text-xs font-semibold text-[var(--muted)]">Employee
          <select name="employeeId" required defaultValue={selected.employeeId} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]">
            <option value="">Choose employee</option>
            {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}{employee.employeeId ? ` (${employee.employeeId})` : ""}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-[var(--muted)]">Leave Type
          <select name="leaveTypeId" required defaultValue={selected.leaveTypeId} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]">
            <option value="">Choose Leave Type</option>
            {leaveTypes.map((leaveType) => <option key={leaveType.id} value={leaveType.id}>{leaveType.name}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-[var(--muted)]">Period start
          <input name="periodStart" type="date" required value={selected.periodStart} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]" />
        </label>
        <label className="text-xs font-semibold text-[var(--muted)]">Period end
          <input name="periodEnd" type="date" required value={selected.periodEnd} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]" />
        </label>
        <button type="submit" className="h-10 rounded-md bg-[var(--action)] px-4 text-sm font-medium text-white hover:bg-[var(--action-hover)]">Load balance</button>
      </form>

      {lookupError && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{lookupError}</p>}

      {!hasLookup && (
        <section role="status" className="rounded-lg border border-[var(--line)] bg-white px-4 py-8 text-center">
          <h2 className="text-base font-semibold">Select an employee and entitlement period</h2>
          <p className="mt-2 text-sm text-[var(--muted)]">Existing credits and approved leave usage will be loaded for the exact selected period.</p>
        </section>
      )}

      {result && (
        <section className="space-y-4" aria-label="Leave balance result">
          <div>
            <h2 className="text-lg font-semibold">{result.employee.name} · {result.leaveType.name}</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">{selected.periodStart} – {selected.periodEnd}</p>
          </div>
          {!result.entitlement ? (
            <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-950">No entitlement is configured for this employee, Leave Type, and period. Enter the credit values below to create it.</p>
          ) : (
            <>
              {result.balance?.scheduleUnavailable && <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">Used leave and available balance cannot be calculated until this employee has a Shift with configured working days.</p>}
              {result.balance?.scopedHolidaysUnresolved && <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">Some branch/group holidays could not be matched to this employee because employee branch/group assignment is not available. The balance is an estimate using company-wide holidays.</p>}
              <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <div className="rounded-lg border border-[var(--line)] bg-white p-4"><dt className="text-xs text-[var(--muted)]">Opening balance</dt><dd className="mt-2 text-xl font-semibold">{result.entitlement.openingBalance.toString()}</dd></div>
                <div className="rounded-lg border border-[var(--line)] bg-white p-4"><dt className="text-xs text-[var(--muted)]">Entitlement</dt><dd className="mt-2 text-xl font-semibold">{result.entitlement.entitlement.toString()}</dd></div>
                <div className="rounded-lg border border-[var(--line)] bg-white p-4"><dt className="text-xs text-[var(--muted)]">Carry forward</dt><dd className="mt-2 text-xl font-semibold">{result.entitlement.carryForward.toString()}</dd></div>
                <div className="rounded-lg border border-[var(--line)] bg-white p-4"><dt className="text-xs text-[var(--muted)]">Approved leave used</dt><dd className="mt-2 text-xl font-semibold">{result.balance?.approvedLeaveUsed?.toString() ?? "Unavailable"}</dd></div>
                <div className="rounded-lg border border-[var(--line)] bg-white p-4"><dt className="text-xs text-[var(--muted)]">Available balance</dt><dd className="mt-2 text-xl font-semibold">{result.balance?.availableBalance?.toString() ?? "Unavailable"}</dd></div>
              </dl>
            </>
          )}
          <LeaveEntitlementForm
            employeeId={result.employee.id}
            leaveTypeId={result.leaveType.id}
            periodStart={selected.periodStart}
            periodEnd={selected.periodEnd}
            openingBalance={result.entitlement?.openingBalance.toString()}
            entitlement={result.entitlement?.entitlement.toString()}
            carryForward={result.entitlement?.carryForward.toString()}
          />
        </section>
      )}
    </div>
  );
}