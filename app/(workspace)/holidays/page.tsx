import { formatInTimeZone } from "date-fns-tz";
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { HolidayDeleteForm } from "@/components/holiday-delete-form";
import { hasPermission } from "@/lib/auth/permissions";
import { requirePageUser } from "@/lib/auth/session";
import { listHolidaysForMonth } from "@/lib/holidays/service";
import { holidayListQuerySchema } from "@/lib/holidays/validation";
import type { HolidayType } from "@prisma/client";

type SearchParams = { month?: string | string[]; success?: string | string[]; error?: string | string[] };

const holidayTypeLabels: Record<HolidayType, string> = {
  PUBLIC: "Public",
  POYA: "Poya",
  COMPANY: "Company",
  SPECIAL: "Special",
  BRANCH_SPECIFIC: "Branch-specific",
};

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

function localDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function shiftMonth(month: string, amount: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1 + amount, 1)).toISOString().slice(0, 7);
}

export default async function HolidaysPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePageUser();
  const params = await searchParams;
  const currentMonth = formatInTimeZone(new Date(), user.timeZone, "yyyy-MM");
  const requestedMonth = single(params.month);
  const parsedMonth = holidayListQuerySchema.safeParse({ month: requestedMonth || currentMonth });
  const month = parsedMonth.success ? parsedMonth.data.month : currentMonth;
  const holidays = await listHolidaysForMonth(user, month);
  const canManage = hasPermission(user.role, "holiday:manage");

  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const firstCalendarDay = new Date(Date.UTC(year, monthNumber - 1, 1 - ((firstWeekday + 6) % 7)));
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const cellCount = Math.ceil((((firstWeekday + 6) % 7) + dayCount) / 7) * 7;
  const dates = Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(firstCalendarDay);
    date.setUTCDate(firstCalendarDay.getUTCDate() + index);
    return date;
  });
  const holidaysByDate = new Map<string, typeof holidays>();
  for (const holiday of holidays) {
    const key = localDate(holiday.date);
    const day = holidaysByDate.get(key) ?? [];
    day.push(holiday);
    holidaysByDate.set(key, day);
  }
  const dayCountWithHoliday = holidaysByDate.size;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[var(--blue)]">Workspace</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Holiday calendar</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">{holidays.length} holiday{holidays.length === 1 ? "" : "s"} across {dayCountWithHoliday} date{dayCountWithHoliday === 1 ? "" : "s"}</p>
        </div>
        {canManage && <Link href="/holidays/new" className="inline-flex h-10 items-center gap-2 rounded-md bg-[var(--action)] px-3.5 text-sm font-semibold text-white hover:bg-[var(--action-hover)]"><Plus size={17} aria-hidden="true" /> Add holiday</Link>}
      </div>

      {single(params.error) && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{single(params.error)}</p>}
      {single(params.success) && <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{single(params.success)}</p>}
      {!parsedMonth.success && requestedMonth && <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Invalid month. Showing the current month.</p>}

      <section aria-label="Calendar controls" className="flex flex-wrap items-center justify-between gap-3 border-y border-[var(--line)] py-3">
        <div className="flex items-center gap-2">
          <Link aria-label="Previous month" href={`/holidays?month=${shiftMonth(month, -1)}`} className="grid size-9 place-items-center rounded-md border border-[var(--line)] hover:bg-zinc-50"><ChevronLeft size={17} aria-hidden="true" /></Link>
          <form method="get" className="flex items-center gap-2">
            <label htmlFor="holiday-month" className="sr-only">Calendar month</label>
            <input id="holiday-month" name="month" type="month" defaultValue={month} className="h-9 w-[132px] rounded-md border border-[var(--line)] bg-white px-2.5 text-sm sm:w-auto" />
            <button type="submit" className="h-9 rounded-md border border-[var(--line)] px-3 text-sm font-medium hover:bg-zinc-50">Go</button>
          </form>
          <Link aria-label="Next month" href={`/holidays?month=${shiftMonth(month, 1)}`} className="grid size-9 place-items-center rounded-md border border-[var(--line)] hover:bg-zinc-50"><ChevronRight size={17} aria-hidden="true" /></Link>
        </div>
        <p className="inline-flex items-center gap-2 text-sm font-semibold"><CalendarDays size={17} className="text-[var(--blue)]" aria-hidden="true" />{new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00.000Z`))}</p>
      </section>

      <div className="overflow-hidden rounded-lg border border-[var(--line)] bg-white">
        <div>
          <div className="grid grid-cols-7 border-b border-[var(--line)] bg-zinc-50 text-center text-[10px] font-semibold text-[var(--muted)] sm:text-left sm:text-xs">
            {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => (
              <div key={day} aria-label={day} className="px-0.5 py-2 sm:px-3 sm:py-2.5">
                <span aria-hidden="true" className="sm:hidden">{day.slice(0, 2)}</span>
                <span className="hidden sm:inline">{day}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {dates.map((date) => {
              const key = localDate(date);
              const isCurrentMonth = date.getUTCMonth() === monthNumber - 1;
              const dayHolidays = holidaysByDate.get(key) ?? [];
              return (
                <div key={key} className={`min-h-20 border-b border-r border-[var(--line)] p-1 sm:min-h-28 sm:p-2.5 ${isCurrentMonth ? "bg-white" : "bg-zinc-50/70"}`}>
                  <p className={`text-[10px] font-semibold tabular-nums sm:text-xs ${isCurrentMonth ? "text-[var(--ink)]" : "text-zinc-400"}`}>{date.getUTCDate()}</p>
                  <div className="mt-1 space-y-1 sm:mt-2">
                    {dayHolidays.map((holiday) => <div key={holiday.id} className="rounded-sm border-l-2 border-[var(--action)] bg-[var(--mint)] px-1 py-0.5 text-[9px] leading-3 text-[var(--ink)] sm:px-2 sm:py-1 sm:text-xs sm:leading-4" title={`${holiday.name} · ${holidayTypeLabels[holiday.type]}`}><span className="block truncate font-semibold">{holiday.name}</span><span className="hidden truncate text-[10px] text-[var(--muted)] sm:block">{holidayTypeLabels[holiday.type]}{holiday.branch ? ` · ${holiday.branch}` : ""}</span></div>)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <section aria-labelledby="holiday-list-title" className="space-y-3">
        <div className="flex items-end justify-between gap-3"><div><h2 id="holiday-list-title" className="text-base font-semibold">Holiday list</h2><p className="mt-1 text-xs text-[var(--muted)]">Details for {month}</p></div></div>
        {holidays.length === 0 ? (
          <div className="flex min-h-44 flex-col items-center justify-center rounded-lg border border-dashed border-[var(--line)] bg-white px-6 text-center"><CalendarDays size={24} className="text-[var(--muted)]" aria-hidden="true" /><h3 className="mt-3 text-sm font-semibold">No holidays this month</h3><p className="mt-1 text-sm text-[var(--muted)]">{canManage ? "Add a holiday to populate the calendar." : "There are no holidays on the calendar for this month."}</p></div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-[var(--line)] bg-white">
            <ul className="divide-y divide-[var(--line)] lg:hidden">
              {holidays.map((holiday) => (
                <li key={holiday.id} className="space-y-3 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs tabular-nums text-[var(--muted)]">{localDate(holiday.date)}</p>
                      <h3 className="mt-1 break-words text-sm font-semibold">{holiday.name}</h3>
                    </div>
                    {canManage && (
                      <div className="flex shrink-0 gap-2">
                        <Link href={`/holidays/${holiday.id}/edit`} className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm font-medium hover:bg-zinc-50">Edit</Link>
                        <HolidayDeleteForm id={holiday.id} name={holiday.name} />
                      </div>
                    )}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                    <div className="min-w-0">
                      <dt className="font-semibold text-[var(--muted)]">Type / scope</dt>
                      <dd className="mt-1 break-words">{holidayTypeLabels[holiday.type]}{holiday.branch ? ` · ${holiday.branch}` : ""}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="font-semibold text-[var(--muted)]">Employee groups</dt>
                      <dd className="mt-1 break-words">{holiday.applicableEmployeeGroups.length ? holiday.applicableEmployeeGroups.join(", ") : "All employee groups"}</dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-[var(--muted)]">Pay</dt>
                      <dd className="mt-1">{holiday.isPaid ? "Paid" : "Unpaid"}</dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-[var(--muted)]">Overtime</dt>
                      <dd className="mt-1">{holiday.overtimeEligible ? "Eligible" : "Not eligible"}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto lg:block"><table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--line)] bg-zinc-50 text-xs text-[var(--muted)]"><tr><th className="px-4 py-3 font-semibold">Date</th><th className="px-4 py-3 font-semibold">Holiday</th><th className="px-4 py-3 font-semibold">Type / scope</th><th className="px-4 py-3 font-semibold">Paid</th><th className="px-4 py-3 font-semibold">OT</th>{canManage && <th className="px-4 py-3 text-right font-semibold">Actions</th>}</tr></thead>
              <tbody className="divide-y divide-[var(--line)]">{holidays.map((holiday) => <tr key={holiday.id}>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums">{localDate(holiday.date)}</td>
                <td className="px-4 py-3 font-medium">{holiday.name}<span className="mt-0.5 block text-xs text-[var(--muted)]">{holiday.applicableEmployeeGroups.length ? holiday.applicableEmployeeGroups.join(", ") : "All employee groups"}</span></td>
                <td className="px-4 py-3">{holidayTypeLabels[holiday.type]}{holiday.branch ? <span className="block text-xs text-[var(--muted)]">{holiday.branch}</span> : null}</td>
                <td className="px-4 py-3">{holiday.isPaid ? "Paid" : "Unpaid"}</td>
                <td className="px-4 py-3">{holiday.overtimeEligible ? "Eligible" : "Not eligible"}</td>
                {canManage && <td className="px-4 py-3"><div className="flex justify-end gap-2"><Link href={`/holidays/${holiday.id}/edit`} className="rounded-md border border-[var(--line)] px-3 py-1.5 text-sm font-medium hover:bg-zinc-50">Edit</Link><HolidayDeleteForm id={holiday.id} name={holiday.name} /></div></td>}
              </tr>)}</tbody>
            </table></div>
          </div>
        )}
      </section>
    </div>
  );
}