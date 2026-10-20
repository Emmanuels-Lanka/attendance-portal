import { formatInTimeZone } from "date-fns-tz";
import { prisma } from "@/lib/prisma";
import { requirePagePermission } from "@/lib/auth/session";

type SearchParams = { action?: string; employeeId?: string; from?: string; to?: string };

function parseDate(value: string | undefined, endOfDay = false) {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function readable(value: unknown) {
  return value === null || value === undefined ? "—" : JSON.stringify(value, null, 2);
}

function organizationRecordId(...values: unknown[]) {
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !("entityId" in value)) continue;
    const id = (value as Record<string, unknown>).entityId;
    if (typeof id === "string") return id;
  }
  return null;
}

function shiftRecordId(...values: unknown[]) {
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !("shiftId" in value)) continue;
    const id = (value as Record<string, unknown>).shiftId;
    if (typeof id === "string") return id;
  }
  return null;
}

function leaveTypeRecordId(...values: unknown[]) {
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !("leaveTypeId" in value)) continue;
    const id = (value as Record<string, unknown>).leaveTypeId;
    if (typeof id === "string") return id;
  }
  return null;
}

export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePagePermission("audit:read");
  const params = await searchParams;
  const from = parseDate(params.from);
  const to = parseDate(params.to, true);
  const invalid = from === null || to === null || Boolean(params.action && !/^[A-Z0-9_]{1,64}$/.test(params.action));
  const [employees, entries] = invalid ? [[], []] : await Promise.all([
    prisma.user.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.attendanceAuditLog.findMany({
      where: {
        ...(params.action ? { actionType: params.action } : {}),
        ...(params.employeeId ? { employeeId: params.employeeId } : {}),
        ...((from || to) ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      select: {
        id: true,
        employeeId: true,
        sessionId: true,
        correctionRequestId: true,
        actionType: true,
        previousValues: true,
        newValues: true,
        reason: true,
        createdAt: true,
        employee: { select: { id: true, name: true, employeeCode: true } },
        actor: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-[var(--blue)]">Administration</p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Audit history</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">Attendance location access, corrections, request reviews, and employee or settings changes.</p>
      </div>
      <form method="get" className="grid gap-3 rounded-lg border border-[var(--line)] bg-white p-4 sm:grid-cols-2 xl:grid-cols-4 xl:items-end">
        <label className="text-xs font-semibold text-[var(--muted)]">Action type
          <input name="action" defaultValue={params.action ?? ""} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] px-2.5 text-sm text-[var(--ink)]" placeholder="All actions" />
        </label>
        <label className="text-xs font-semibold text-[var(--muted)]">Employee
          <select name="employeeId" defaultValue={params.employeeId ?? ""} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]">
            <option value="">All employees</option>
            {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-[var(--muted)]">From (UTC)
          <input type="date" name="from" defaultValue={params.from ?? ""} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] px-2.5 text-sm text-[var(--ink)]" />
        </label>
        <label className="text-xs font-semibold text-[var(--muted)]">To (UTC)
          <input type="date" name="to" defaultValue={params.to ?? ""} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] px-2.5 text-sm text-[var(--ink)]" />
        </label>
        <button type="submit" className="h-10 rounded-md bg-[var(--action)] px-4 text-sm font-medium text-white hover:bg-[var(--action-hover)]">Filter history</button>
      </form>
      {invalid ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">The selected action or date range is invalid.</p>
      ) : entries.length === 0 ? (
        <p role="status" className="rounded-lg border border-[var(--line)] bg-white px-4 py-8 text-sm text-[var(--muted)]">No audit entries match these filters.</p>
      ) : (
        <ol className="divide-y divide-[var(--line)] overflow-hidden rounded-lg border border-[var(--line)] bg-white">
          {entries.map((entry) => (
            <li key={entry.id} className="grid gap-4 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(180px,0.7fr)_minmax(0,1.3fr)]">
              <div>
                <p className="text-sm font-semibold">{entry.actionType.replaceAll("_", " ")}</p>
                <p className="mt-1 text-xs text-[var(--muted)]">Affected record: {entry.employee ? `${entry.employee.name}${entry.employee.employeeCode ? ` · ${entry.employee.employeeCode}` : ""}` : entry.sessionId ? `Session ${entry.sessionId}` : entry.correctionRequestId ? `Correction request ${entry.correctionRequestId}` : entry.actionType.startsWith("DEPARTMENT_") ? `Department ${organizationRecordId(entry.newValues, entry.previousValues) ?? ""}` : entry.actionType.startsWith("DESIGNATION_") ? `Designation ${organizationRecordId(entry.newValues, entry.previousValues) ?? ""}` : entry.actionType.startsWith("SHIFT_") ? `Shift ${shiftRecordId(entry.newValues, entry.previousValues) ?? ""}` : entry.actionType.startsWith("LEAVE_TYPE_") ? `Leave Type ${leaveTypeRecordId(entry.newValues, entry.previousValues) ?? ""}` : entry.actionType.startsWith("SETTING_") ? "Organization setting" : "Unlinked record"}</p>
                <p className="mt-1 text-xs text-[var(--muted)]">Actor: {entry.actor?.name ?? "System"}</p>
                <time className="mt-1 block text-xs text-[var(--muted)]" dateTime={entry.createdAt.toISOString()}>{formatInTimeZone(entry.createdAt, "UTC", "yyyy-MM-dd HH:mm:ss 'UTC'")}</time>
                {entry.reason && <p className="mt-2 text-sm leading-5">Reason: {entry.reason}</p>}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><h2 className="text-xs font-semibold text-[var(--muted)]">Before</h2><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 text-xs">{readable(entry.previousValues)}</pre></div>
                <div><h2 className="text-xs font-semibold text-[var(--muted)]">After</h2><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 text-xs">{readable(entry.newValues)}</pre></div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {entries.length === 500 && <p role="status" className="text-xs text-[var(--muted)]">Showing the 500 most recent matching audit entries. Add filters to narrow the history.</p>}
    </div>
  );
}