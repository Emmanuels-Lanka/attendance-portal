"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Clock3, House, LogIn, LogOut } from "lucide-react";
import { performAttendanceAction } from "@/app/(workspace)/dashboard/actions";
import type { AttendanceAction } from "@/lib/attendance/validation";
import type { AttendanceDay } from "@/lib/attendance/history";
import { formatWorkedDuration } from "@/lib/attendance/history";
import type { WorkSessionTiming } from "@/lib/attendance/schedule";
import { LocalDateTime } from "@/components/local-date-time";
import { AttendancePunch } from "@/components/attendance-punch";
import { AttendanceGeolocationError, captureAttendanceLocation } from "@/lib/attendance/geolocation";

type Session = { id: string; mode: "OFFICE" | "WFH"; startAt: Date; endAt: Date | null };

function elapsedLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${remainder}`;
}

export function AttendanceToday({
  activeSession,
  previousDayActiveSession,
  activeSessionTiming,
  previousDayActiveSessionTiming,
  day,
  attendanceDate,
  timeZone,
  invalidSessions,
  completedSessionToday,
}: {
  activeSession: Session | null;
  previousDayActiveSession: Session | null;
  activeSessionTiming: WorkSessionTiming | null;
  previousDayActiveSessionTiming: WorkSessionTiming | null;
  day: AttendanceDay;
  attendanceDate: string;
  timeZone: string;
  invalidSessions: number;
  completedSessionToday: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [capturingLocation, setCapturingLocation] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const submissionInProgress = useRef(false);
  const router = useRouter();

  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function submit(action: AttendanceAction) {
    if (submissionInProgress.current) return;
    submissionInProgress.current = true;
    setNotice(null);
    setCapturingLocation(true);

    let location;
    try {
      location = await captureAttendanceLocation(
        typeof navigator === "undefined" ? undefined : navigator.geolocation,
      );
    } catch (error) {
      setNotice({
        text: error instanceof AttendanceGeolocationError
          ? error.message
          : "A location could not be obtained. Enable location access and try again.",
        error: true,
      });
      setCapturingLocation(false);
      submissionInProgress.current = false;
      return;
    }

    setCapturingLocation(false);
    startTransition(async () => {
      try {
        const result = await performAttendanceAction({ action, location });
        if (result.ok) {
          setNotice({ text: result.message, error: false });
          router.refresh();
        } else {
          setNotice({ text: result.error, error: true });
        }
      } catch {
        setNotice({ text: "Attendance could not be updated. Try again shortly.", error: true });
      } finally {
        submissionInProgress.current = false;
      }
    });
  }

  const sessionToEnd = activeSession ?? previousDayActiveSession;
  const hasCompletedSession = completedSessionToday || day.sessions.some(({ status }) => status === "COMPLETED");
  const actions: { action: AttendanceAction; label: string; icon: typeof LogIn }[] = sessionToEnd
    ? [{
        action: sessionToEnd.mode === "WFH" ? "WFH_OUT" : "OUT",
        label: previousDayActiveSession
          ? sessionToEnd.mode === "WFH" ? "WFH-OUT (previous day)" : "OUT (previous day)"
          : sessionToEnd.mode === "WFH" ? "WFH-OUT" : "OUT",
        icon: LogOut,
      }]
    : hasCompletedSession ? [] : [
        { action: "IN", label: "IN", icon: LogIn },
        { action: "WFH_IN", label: "WFH-IN", icon: House },
      ];

  return (
    <section className="overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--line)] px-5 py-5 sm:px-7 sm:py-6">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--blue)]">Current session</p>
          <h2 className="mt-2 text-xl font-semibold">Your work status</h2>
        </div>
          <p className="max-w-full break-words text-right text-xs text-[var(--muted)] sm:text-sm">Today: {attendanceDate} · {timeZone}</p>
      </div>
      <div className="grid gap-6 px-5 py-6 sm:px-7 sm:py-7 lg:grid-cols-[minmax(0,1fr)_minmax(210px,0.65fr)] lg:gap-10">
        <div>
          <div className="flex items-center gap-3">
            <span className={`grid size-11 place-items-center rounded-full ${activeSession ? "bg-[var(--mint)] text-[var(--mint-ink)]" : "bg-zinc-100 text-zinc-600"}`}>
              {activeSession ? <Clock3 size={20} aria-hidden="true" /> : <Check size={20} aria-hidden="true" />}
            </span>
            <div>
              <p className="text-xs text-[var(--muted)]">Current attendance state</p>
              <p className="mt-1 text-base font-semibold">
                {activeSession
                  ? `Active ${activeSession.mode === "WFH" ? "WFH" : "office"} session`
                  : previousDayActiveSession
                    ? "Open session from a previous local day"
                    : "No active session"}
              </p>
            </div>
          </div>
          {activeSession ? (
            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="rounded-md bg-zinc-50 p-3.5">
                <p className="text-xs text-[var(--muted)]">Session start</p>
                <p className="mt-1.5 text-sm font-semibold"><LocalDateTime value={activeSession.startAt} timeZone={timeZone} /></p>
                <p className="mt-1 text-xs text-[var(--muted)]">{activeSessionTiming?.arrival.replaceAll("_", " ")}</p>
              </div>
              <div className="rounded-md bg-zinc-50 p-3.5">
                <p className="text-xs text-[var(--muted)]">Session duration</p>
                <p className="mt-1.5 text-sm font-semibold tabular-nums">
                  {now !== null ? elapsedLabel(now - activeSession.startAt.getTime()) : "—"}
                </p>
              </div>
            </div>
          ) : previousDayActiveSession ? (
            <div className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-semibold">This session is not part of today&apos;s attendance.</p>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Started <LocalDateTime value={previousDayActiveSession.startAt} timeZone={timeZone} />.
                End this {previousDayActiveSession.mode === "WFH" ? "WFH" : "office"} session to continue.
              </p>
              <p className="mt-2 text-xs text-[var(--muted)]">
                {previousDayActiveSessionTiming?.arrival.replaceAll("_", " ")}
              </p>
            </div>
          ) : hasCompletedSession ? (
            <p className="mt-5 max-w-md text-sm leading-6 text-[var(--muted)]">
              {day.sessions.length === 0
                ? "A session started on an earlier local date ended today. New attendance actions will be available tomorrow."
                : "You have already completed attendance for your local day. New attendance actions will be available tomorrow."}
            </p>
          ) : (
            <p className="mt-5 max-w-md text-sm leading-6 text-[var(--muted)]">There is no active session. Start an office or WFH session when you begin work.</p>
          )}
        </div>
        <div className="flex flex-col justify-center border-t border-[var(--line)] pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <p className="mb-3 text-xs font-semibold text-[var(--muted)]">
            {previousDayActiveSession
              ? "End previous-day session"
              : hasCompletedSession && !activeSession ? "Attendance complete" : "Available action"}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
            {actions.map(({ action, label, icon: Icon }) => {
              const isOut = action === "OUT" || action === "WFH_OUT";
              return (
              <button
                key={action}
                type="button"
                disabled={pending || capturingLocation}
                onClick={() => submit(action)}
                className={`flex h-14 items-center justify-center gap-2 rounded-md border px-4 text-sm font-semibold transition disabled:cursor-wait disabled:opacity-60 ${isOut ? "border-[var(--danger)] bg-[var(--danger)] text-white hover:brightness-95" : "border-[var(--logo-blue)] bg-[var(--logo-blue)] text-white hover:brightness-95"}`}
              >
                <Icon size={18} aria-hidden="true" />
                {capturingLocation ? "Getting location..." : pending ? "Saving..." : label}
              </button>
              );
            })}
          </div>
          <p className="mt-3 text-xs leading-5 text-[var(--muted)]">
            Device location is required for every IN and OUT punch, including WFH. It is requested only when you press an attendance button.
          </p>
          {hasCompletedSession && !sessionToEnd && (
            <p className="text-sm font-medium text-[var(--mint-ink)]">
              {day.sessions.length === 0
                ? "A previous-day session ended within today's attendance window."
                : "Attendance is already completed for today."}
            </p>
          )}
          <p role={notice?.error ? "alert" : "status"} aria-live="polite" className={`mt-3 min-h-5 text-xs ${notice?.error ? "text-[var(--danger)]" : "text-[var(--mint-ink)]"}`}>
            {notice?.text ?? ""}
          </p>
        </div>
      </div>
      <div className="border-t border-[var(--line)] px-5 py-5 sm:px-7">
        <div>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[var(--blue)]">Today&apos;s sessions</p>
              <h3 className="mt-1 text-sm font-semibold">{day.sessions.length} session{day.sessions.length === 1 ? "" : "s"}</h3>
            </div>
            <div className="text-right">
              <p className="text-xs text-[var(--muted)]">Completed worked time</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{formatWorkedDuration(day.totalWorkedMs)}</p>
            </div>
          </div>
          {day.sessions.at(-1) && (
            <p className="mt-3 text-xs text-[var(--muted)]">Latest today: {day.sessions.at(-1)?.session.mode === "WFH" ? "WFH" : "Office"} · <LocalDateTime value={day.sessions.at(-1)!.session.startAt} timeZone={timeZone} /></p>
          )}
          <p className="mt-1 text-xs leading-5 text-[var(--muted)]">Local dates and times use your assigned timezone. Active sessions are excluded from worked time.</p>
        </div>
        {day.sessions.length > 0 ? (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {day.sessions.map(({ session, timing, durationMs, status }) => (
              <li key={session.id} className="grid min-w-0 gap-2">
                <AttendancePunch kind={session.mode === "WFH" ? "WFH_IN" : "IN"}>
                  <p className="font-semibold"><LocalDateTime value={session.startAt} timeZone={timeZone} /></p>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">{timing?.arrival.replaceAll("_", " ") ?? "Timing unavailable"}</p>
                </AttendancePunch>
                <AttendancePunch kind={session.mode === "WFH" ? "WFH_OUT" : "OUT"}>
                  <p className="font-semibold">{status === "ACTIVE" ? "Awaiting OUT" : status === "INVALID" ? "Data unavailable" : <LocalDateTime value={session.endAt!} timeZone={timeZone} />}</p>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">{status === "COMPLETED" ? `${formatWorkedDuration(durationMs)}${timing?.departure ? ` · ${timing.departure.replaceAll("_", " ")}` : ""}` : status === "ACTIVE" ? "Session active" : "Timing unavailable"}</p>
                </AttendancePunch>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-[var(--muted)]">No attendance has been recorded for this local date.</p>
        )}
        {invalidSessions > 0 && <p role="status" className="mt-3 text-xs text-[var(--amber-ink)]">{invalidSessions} session record{invalidSessions === 1 ? "" : "s"} could not be summarized because its timestamps are invalid.</p>}
      </div>
    </section>
  );
}