import { formatInTimeZone } from "date-fns-tz";
import { CalendarDays } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AttendanceMapLink } from "@/components/attendance-map-link";
import {
  dailyAttendanceFiltersSchema,
  listCalculatedDailyAttendance,
} from "@/lib/attendance/daily-read";
import { listAttendanceLocations } from "@/lib/attendance/location-service";
import { canReadScopedAttendance, hasPermission } from "@/lib/auth/permissions";
import { requirePageUser } from "@/lib/auth/session";

type SearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

function statusPresentation(status: string | null) {
  switch (status) {
    case "PRESENT": return { label: "Present", className: "bg-emerald-50 text-emerald-800" };
    case "LATE": return { label: "Late", className: "bg-amber-50 text-amber-800" };
    case "EARLY_OUT": return { label: "Early Out", className: "bg-orange-50 text-orange-800" };
    case "ABSENT": return { label: "Absent", className: "bg-rose-50 text-rose-800" };
    case "LEAVE": return { label: "Leave", className: "bg-[var(--mint)] text-[var(--mint-ink)]" };
    case "WFH": return { label: "WFH", className: "bg-sky-50 text-sky-800" };
    case "MISSING_PUNCH": return { label: "Missing Punch", className: "bg-rose-50 text-rose-800" };
    case "WEEKEND": return { label: "Weekend", className: "bg-slate-100 text-slate-700" };
    case "HOLIDAY": return { label: "Holiday", className: "bg-[var(--mint)] text-[var(--mint-ink)]" };
    case "UNDETERMINED": return { label: "Undetermined", className: "bg-slate-100 text-slate-700" };
    case null: return { label: "Not calculated", className: "bg-slate-100 text-slate-700" };
    default: return { label: status, className: "bg-slate-100 text-slate-700" };
  }
}

function timeLabel(value: Date | null, timeZone: string | null) {
  if (!value) return "—";
  return formatInTimeZone(value, timeZone ?? "UTC", "HH:mm");
}

function hoursLabel(value: { toString(): string } | null) {
  return value ? `${value.toString()} h` : "—";
}

function attendanceHref(filters: {
  date: string;
  employeeId: string;
  departmentId: string;
  status: string;
}, page: number) {
  const query = new URLSearchParams();
  if (filters.date) query.set("date", filters.date);
  if (filters.employeeId) query.set("employeeId", filters.employeeId);
  if (filters.departmentId) query.set("departmentId", filters.departmentId);
  if (filters.status !== "ALL") query.set("status", filters.status);
  if (page > 1) query.set("page", String(page));
  const search = query.toString();
  return `/admin/attendance/daily${search ? `?${search}` : ""}`;
}

export default async function DailyAttendancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requirePageUser();
  const canReadAttendance = actor.role === "ADMIN"
    || hasPermission(actor.role, "attendance:manage")
    || canReadScopedAttendance(actor.role);
  if (!canReadAttendance) redirect("/dashboard");
  const audienceLabel = actor.role === "HR_ADMINISTRATOR" ? "HR attendance"
    : actor.role === "DEPARTMENT_MANAGER" ? "Department attendance"
      : actor.role === "SUPERVISOR" ? "Assigned attendance" : "Administration";
  const params = await searchParams;
  const filterResult = dailyAttendanceFiltersSchema.safeParse({
    date: single(params.date),
    employeeId: single(params.employeeId),
    departmentId: single(params.departmentId),
    status: single(params.status) || "ALL",
    page: single(params.page) || "1",
  });

  if (!filterResult.success) {
    return (
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-[var(--blue)]">{audienceLabel}</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Daily attendance</h1>
        </div>
        <section className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm" aria-label="Invalid attendance filters">
          <p role="alert" className="text-sm text-[var(--danger)]">
            {filterResult.error.issues[0]?.message ?? "One or more filters are invalid."}
          </p>
          <Link href="/admin/attendance/daily" className="mt-4 inline-flex h-10 items-center rounded-md border border-[var(--line)] px-4 text-sm font-medium hover:bg-zinc-50">
            Clear filters
          </Link>
        </section>
      </div>
    );
  }

  let result: Awaited<ReturnType<typeof listCalculatedDailyAttendance>>;
  try {
    result = await listCalculatedDailyAttendance(actor, filterResult.data);
  } catch (error) {
    console.error("Calculated daily attendance read failed", error instanceof Error ? error.name : "Unknown error");
    return (
      <div className="space-y-6">
        <div>
          <p className="text-sm font-medium text-[var(--blue)]">{audienceLabel}</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Daily attendance</h1>
        </div>
        <section className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm">
          <p role="alert" className="text-sm text-[var(--danger)]">Calculated attendance could not be loaded. Try again shortly.</p>
        </section>
      </div>
    );
  }

  const { filters } = result;
  const canReadLocations = hasPermission(actor.role, "attendance:locations:read");
  let locationRecords: Awaited<ReturnType<typeof listAttendanceLocations>> = [];
  let locationReadFailed = false;
  if (canReadLocations && filters.date) {
    try {
      locationRecords = await listAttendanceLocations(actor, {
        date: filters.date,
        employeeId: filters.employeeId,
        departmentId: filters.departmentId,
      });
    } catch (error) {
      locationReadFailed = true;
      console.error("Attendance location read failed", error instanceof Error ? error.name : "Unknown error");
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[var(--blue)]">{audienceLabel}</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Daily attendance</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {result.total} calculated record{result.total === 1 ? "" : "s"}
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-md bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700">
          <CalendarDays size={15} aria-hidden="true" />
          Calculated daily records
        </span>
      </header>

      <p className="rounded-md border border-[var(--line)] bg-white px-4 py-3 text-sm leading-6 text-[var(--muted)]">
        This screen shows calculated daily attendance. Raw attendance punches remain separate, immutable evidence and are not edited here. Times use the employee&apos;s assigned timezone, or UTC if no linked account timezone is available.
      </p>

      <form method="get" className="grid gap-3 rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm sm:grid-cols-2 xl:grid-cols-5 xl:items-end">
        <label className="text-xs font-semibold text-[var(--muted)]">
          Date
          <input name="date" type="date" defaultValue={filters.date} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]" />
        </label>
        <label className="text-xs font-semibold text-[var(--muted)]">
          Employee
          <select name="employeeId" defaultValue={filters.employeeId} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]">
            <option value="">All employees</option>
            {result.employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}{employee.employeeId ? ` (${employee.employeeId})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-semibold text-[var(--muted)]">
          Department
          <select name="departmentId" defaultValue={filters.departmentId} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]">
            <option value="">All departments</option>
            {result.departments.map((department) => (
              <option key={department.id} value={department.id}>{department.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-semibold text-[var(--muted)]">
          Current status
          <select name="status" defaultValue={filters.status} className="mt-1.5 h-10 w-full rounded-md border border-[var(--line)] bg-white px-2.5 text-sm text-[var(--ink)]">
            <option value="ALL">All statuses</option>
            <option value="PRESENT">Present</option>
            <option value="LATE">Late</option>
            <option value="EARLY_OUT">Early Out</option>
            <option value="ABSENT">Absent</option>
            <option value="LEAVE">Leave</option>
            <option value="WFH">WFH</option>
            <option value="MISSING_PUNCH">Missing Punch</option>
            <option value="WEEKEND">Weekend</option>
            <option value="HOLIDAY">Holiday</option>
            <option value="UNDETERMINED">Undetermined</option>
          </select>
        </label>
        <div className="flex items-center gap-2">
          <button type="submit" className="h-10 rounded-md bg-[var(--action)] px-3.5 text-sm font-medium text-white hover:bg-[var(--action-hover)]">
            Apply filters
          </button>
          <Link href="/admin/attendance/daily" className="inline-flex h-10 items-center rounded-md border border-[var(--line)] px-3.5 text-sm font-medium hover:bg-zinc-50">
            Clear
          </Link>
        </div>
      </form>

      {canReadLocations && (
        <section className="overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-sm" aria-labelledby="attendance-locations-title">
          <header className="border-b border-[var(--line)] px-4 py-4 sm:px-5">
            <h2 id="attendance-locations-title" className="text-base font-semibold">Precise punch locations</h2>
            <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
              Device-reported location for each individual IN and OUT punch. Historical punches without saved coordinates remain listed.
            </p>
          </header>
          {!filters.date ? (
            <p className="px-4 py-5 text-sm text-[var(--muted)]">Select a date above to inspect punch locations.</p>
          ) : locationReadFailed ? (
            <p role="alert" className="px-4 py-5 text-sm text-[var(--danger)]">Punch locations could not be loaded. Try again shortly.</p>
          ) : locationRecords.length === 0 ? (
            <p role="status" className="px-4 py-5 text-sm text-[var(--muted)]">No raw attendance punches match this date and employee filter.</p>
          ) : (
            <>
              {locationRecords.length === 1000 && (
                <p role="status" className="border-b border-[var(--line)] px-4 py-3 text-xs text-[var(--muted)]">
                  Showing the 1,000 most recent matching punches. Narrow the date or employee filter to inspect fewer records.
                </p>
              )}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="border-b border-[var(--line)] bg-zinc-50 text-xs text-[var(--muted)]">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Employee</th>
                      <th className="px-4 py-3 font-semibold">Punch</th>
                      <th className="px-4 py-3 font-semibold">Recorded time</th>
                      <th className="px-4 py-3 font-semibold">Coordinates</th>
                      <th className="px-4 py-3 font-semibold">Accuracy</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line)]">
                    {locationRecords.map((punch) => (
                      <tr key={punch.id}>
                        <td className="px-4 py-3">
                          <p className="font-semibold">{punch.employeeName}</p>
                          {punch.employeeCode && <p className="mt-0.5 text-xs text-[var(--muted)]">{punch.employeeCode}</p>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`rounded-sm px-2 py-1 text-xs font-semibold ${punch.punchType === "IN" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
                            {punch.punchType}
                          </span>
                        </td>
                        <td className="px-4 py-3 tabular-nums">
                          {formatInTimeZone(punch.timestamp, punch.timeZone, "yyyy-MM-dd HH:mm:ss")}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">
                          {punch.location
                            ? (
                              <>
                                <span>{punch.location.latitude}, {punch.location.longitude}</span>
                                <AttendanceMapLink location={punch.location} />
                              </>
                            )
                            : <span className="font-sans text-[var(--muted)]">No stored location</span>}
                        </td>
                        <td className="px-4 py-3 tabular-nums">
                          {punch.location?.accuracy !== null && punch.location
                            ? `${punch.location.accuracy} m`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {result.records.length === 0 ? (
        <section className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-[var(--line)] bg-white px-6 text-center">
          <h2 className="text-base font-semibold">{result.total === 0 ? "No calculated attendance records" : "No records on this page"}</h2>
          <p role="status" className="mt-2 max-w-md text-sm leading-6 text-[var(--muted)]">
            {result.total === 0
              ? "Calculated daily attendance will appear here when records are available for the selected filters."
              : "Use the page controls to view the available records."}
          </p>
        </section>
      ) : (
        <section className="overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-sm" aria-label="Calculated daily attendance records">
          <div className="hidden overflow-x-auto xl:block">
            <table className="w-full min-w-[1120px] text-left text-sm">
              <thead className="border-b border-[var(--line)] bg-zinc-50 text-xs text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Employee</th>
                  <th className="px-4 py-3 font-semibold">Department</th>
                  <th className="px-4 py-3 font-semibold">Date</th>
                  <th className="px-4 py-3 font-semibold">Shift</th>
                  <th className="px-4 py-3 font-semibold">First In</th>
                  <th className="px-4 py-3 font-semibold">Last Out</th>
                  <th className="px-4 py-3 font-semibold">Working Hours</th>
                  <th className="px-4 py-3 font-semibold">Late Minutes</th>
                  <th className="px-4 py-3 font-semibold">Early Minutes</th>
                  <th className="px-4 py-3 font-semibold">OT Hours</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)]">
                {result.records.map((record) => {
                  const status = statusPresentation(record.status);
                  return (
                    <tr key={record.id} className="hover:bg-zinc-50/70">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-[var(--ink)]">{record.employee.name}</p>
                        {record.employee.employeeId && <p className="mt-0.5 text-xs text-[var(--muted)]">{record.employee.employeeId}</p>}
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)]">{record.employee.department?.name ?? "—"}</td>
                      <td className="px-4 py-3 tabular-nums">{record.date.toISOString().slice(0, 10)}</td>
                      <td className="px-4 py-3 text-[var(--muted)]">{record.shift?.name ?? "—"}</td>
                      <td className="px-4 py-3 tabular-nums">{timeLabel(record.firstIn, record.employee.user?.timeZone ?? null)}</td>
                      <td className="px-4 py-3 tabular-nums">{timeLabel(record.lastOut, record.employee.user?.timeZone ?? null)}</td>
                      <td className="px-4 py-3 tabular-nums">{hoursLabel(record.workingHours)}</td>
                      <td className="px-4 py-3 tabular-nums">{record.lateMinutes ?? "—"}</td>
                      <td className="px-4 py-3 tabular-nums">{record.earlyMinutes ?? "—"}</td>
                      <td className="px-4 py-3 tabular-nums">{hoursLabel(record.overtimeHours)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-sm px-2 py-1 text-xs font-medium ${status.className}`}>{status.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-[var(--line)] xl:hidden">
            {result.records.map((record) => {
              const status = statusPresentation(record.status);
              return (
                <li key={record.id} className="space-y-3 px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold">{record.employee.name}</p>
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        {record.employee.employeeId ? `${record.employee.employeeId} · ` : ""}
                        {record.employee.department?.name ?? "No department"} · {record.date.toISOString().slice(0, 10)}
                      </p>
                    </div>
                    <span className={`inline-flex rounded-sm px-2 py-1 text-xs font-medium ${status.className}`}>{status.label}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <span className="text-[var(--muted)]">Shift: <span className="text-[var(--ink)]">{record.shift?.name ?? "—"}</span></span>
                    <span className="text-[var(--muted)]">Working: <span className="text-[var(--ink)]">{hoursLabel(record.workingHours)}</span></span>
                    <span className="text-[var(--muted)]">First In: <span className="text-[var(--ink)]">{timeLabel(record.firstIn, record.employee.user?.timeZone ?? null)}</span></span>
                    <span className="text-[var(--muted)]">Last Out: <span className="text-[var(--ink)]">{timeLabel(record.lastOut, record.employee.user?.timeZone ?? null)}</span></span>
                    <span className="text-[var(--muted)]">Late: <span className="text-[var(--ink)]">{record.lateMinutes ?? "—"} min</span></span>
                    <span className="text-[var(--muted)]">Early: <span className="text-[var(--ink)]">{record.earlyMinutes ?? "—"} min</span></span>
                    <span className="text-[var(--muted)]">OT: <span className="text-[var(--ink)]">{hoursLabel(record.overtimeHours)}</span></span>
                  </div>
                </li>
              );
            })}
          </ul>
          {result.pageCount > 1 && (
            <nav aria-label="Calculated attendance pages" className="flex items-center justify-between border-t border-[var(--line)] px-4 py-3 text-sm">
              <span className="text-[var(--muted)]">Page {result.page} of {result.pageCount}</span>
              <div className="flex gap-2">
                {result.page > 1 && <Link href={attendanceHref(filters, result.page - 1)} className="rounded-md border border-[var(--line)] px-3 py-1.5 hover:bg-zinc-50">Previous</Link>}
                {result.page < result.pageCount && <Link href={attendanceHref(filters, result.page + 1)} className="rounded-md border border-[var(--line)] px-3 py-1.5 hover:bg-zinc-50">Next</Link>}
              </div>
            </nav>
          )}
        </section>
      )}
    </div>
  );
}
