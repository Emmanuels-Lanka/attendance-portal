import Link from "next/link";
import { Pencil } from "lucide-react";
import { ChangePasswordForm } from "@/components/change-password-form";
import { requirePageUser } from "@/lib/auth/session";
import { getEmployeeLocalDayWindow } from "@/lib/attendance/timezone";
import { resolveShiftForDate } from "@/lib/attendance/shift-assignment";
import { prisma } from "@/lib/prisma";

function getWeekDates(today: string) {
  const monday = new Date(`${today}T00:00:00.000Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

function formatTime(value: Date | null) {
  return value?.toISOString().slice(11, 16) ?? "Not set";
}

export default async function EmployeeSettingsPage() {
  const user = await requirePageUser();
  const weekDates = getWeekDates(getEmployeeLocalDayWindow(new Date(), user.timeZone).date);
  const employee = await prisma.employee.findUnique({
    where: { userId: user.id },
    select: {
      shiftAssignments: {
        where: {
          effectiveFrom: { lte: new Date(`${weekDates[6]}T00:00:00.000Z`) },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date(`${weekDates[0]}T00:00:00.000Z`) } }],
        },
        select: {
          effectiveFrom: true,
          effectiveTo: true,
          shift: {
            select: {
              id: true,
              name: true,
              startTime: true,
              endTime: true,
              gracePeriodMinutes: true,
              workingDays: true,
            },
          },
        },
      },
    },
  });
  const assignments = employee?.shiftAssignments ?? [];
  const schedule = weekDates.map((date) => {
    const resolved = resolveShiftForDate(assignments, date);
    const weekday = new Date(`${date}T00:00:00.000Z`).toLocaleDateString("en", {
      weekday: "long",
      timeZone: "UTC",
    });
    const dateLabel = new Date(`${date}T00:00:00.000Z`).toLocaleDateString("en", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });

    if (resolved.kind === "ASSIGNED") {
      return {
        date,
        label: `${weekday}, ${dateLabel}`,
        shift: resolved.shift.name,
        start: formatTime(resolved.shift.startTime),
        end: formatTime(resolved.shift.endTime),
      };
    }

    const message = resolved.kind === "NON_WORKING_DAY"
      ? "Non-working day"
      : resolved.kind === "UNCONFIGURED_WORKING_DAYS"
        ? "Working days not configured"
        : resolved.kind === "AMBIGUOUS"
          ? "Conflicting shift assignments"
          : "No shift assigned";

    return { date, label: `${weekday}, ${dateLabel}`, shift: message, start: "—", end: "—" };
  });

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-[var(--blue)]">Preferences</p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Settings</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Profile</h2>
              <p className="mt-1 text-xs text-[var(--muted)]">Your account identity and assigned work location.</p>
            </div>
            <Link href="/settings/profile" className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-[var(--line)] px-3 text-sm font-medium text-[var(--ink)] hover:bg-slate-50">
              <Pencil size={14} aria-hidden="true" /> Edit profile
            </Link>
          </div>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-[var(--muted)]">Name</dt><dd className="font-medium">{user.name}</dd></div>
            <div><dt className="text-[var(--muted)]">Username</dt><dd className="font-medium">{user.username ?? "Not set"}</dd></div>
            <div><dt className="text-[var(--muted)]">Email</dt><dd className="font-medium">{user.email}</dd></div>
            <div><dt className="text-[var(--muted)]">Country</dt><dd className="font-medium">{user.countryCode}</dd></div>
          </dl>
        </section>

        <section className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold">Attendance schedule</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">Your assigned shift schedule for this week. The schedule is the same for Office and WFH; early arrival is allowed and is not overtime.</p>
          <p className="mt-3 text-sm"><span className="text-[var(--muted)]">Timezone: </span><span className="font-medium">{user.timeZone}</span></p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[440px] text-left text-sm">
              <thead className="border-b border-[var(--line)] text-xs text-[var(--muted)]">
                <tr>
                  <th scope="col" className="pb-2 pr-3 font-medium">Day</th>
                  <th scope="col" className="pb-2 pr-3 font-medium">Shift</th>
                  <th scope="col" className="pb-2 pr-3 font-medium">Start</th>
                  <th scope="col" className="pb-2 font-medium">End</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)]">
                {schedule.map((day) => (
                  <tr key={day.date}>
                    <th scope="row" className="py-2 pr-3 font-medium">{day.label}</th>
                    <td className="py-2 pr-3 text-[var(--muted)]">{day.shift}</td>
                    <td className="py-2 pr-3 tabular-nums">{day.start}</td>
                    <td className="py-2 tabular-nums">{day.end}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold">Change password</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">Changing your password signs out your other active sessions.</p>
        <ChangePasswordForm />
      </section>
    </div>
  );
}
