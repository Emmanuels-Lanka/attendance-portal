import { formatInTimeZone } from "date-fns-tz";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { AttendanceCorrectionRequestForm } from "@/components/attendance-correction-request-form";
import { AttendanceDateCorrectionRequestForm } from "@/components/attendance-date-correction-request-form";
import { AttendanceSessionModeCorrectionForm } from "@/components/attendance-session-mode-correction-form";
import { canSubmitOwnAttendanceCorrection } from "@/lib/auth/permissions";
import {
  listOwnAttendanceCorrectionHistory,
  listOwnDailyAttendanceForCorrection,
  listOwnAttendanceSessionsForCorrection,
} from "@/lib/attendance/correction-service";
import { requirePageUser } from "@/lib/auth/session";
import { redirect } from "next/navigation";

function readableValues(value: unknown) {
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value, null, 2);
}

export default async function AttendanceCorrectionRequestPage() {
  const actor = await requirePageUser();
  if (!canSubmitOwnAttendanceCorrection(actor.role)) {
    redirect("/dashboard");
  }

  const [records, history, sessions] = await Promise.all([
    listOwnDailyAttendanceForCorrection(actor),
    listOwnAttendanceCorrectionHistory(actor),
    listOwnAttendanceSessionsForCorrection(actor),
  ]);
  const pendingDailyAttendanceIds = new Set(
    history.flatMap((request) => request.status === "PENDING" && request.dailyAttendanceId
      ? [request.dailyAttendanceId]
      : []),
  );
  const pendingSessionIds = new Set(
    history.flatMap((request) => request.status === "PENDING" && request.sessionId
      ? [request.sessionId]
      : []),
  );

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard" className="inline-flex items-center gap-1 text-sm text-[var(--muted)]">
          <ChevronLeft size={16} aria-hidden="true" /> Dashboard
        </Link>
        <p className="mt-5 text-sm font-medium text-[var(--blue)]">Personal records</p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Request Attendance Correction</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
          Request a reviewed correction to a session&apos;s punch type or to a calculated daily attendance time.
          The recorded session mode changes only after final approval; original punch evidence is retained.
        </p>
      </div>

      <AttendanceDateCorrectionRequestForm
        attendanceDate={formatInTimeZone(new Date(), actor.timeZone, "yyyy-MM-dd")}
        timeZone={actor.timeZone}
      />

      <section aria-labelledby="session-mode-correction-title" className="space-y-4">
        <div>
          <h2 id="session-mode-correction-title" className="text-lg font-semibold">Wrong IN punch type?</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Request an audited office/WFH mode correction for one of your sessions. Your original IN, WFH-IN, OUT, or WFH-OUT evidence is never rewritten.
          </p>
        </div>
        {sessions.length === 0 ? (
          <p role="status" className="rounded-lg border border-[var(--line)] bg-white px-4 py-6 text-sm text-[var(--muted)]">
            No sessions with an active assigned supervisor are available for a work-mode correction.
          </p>
        ) : (
          <div className="grid gap-4">
            {sessions.map((session) => (
              <AttendanceSessionModeCorrectionForm
                key={session.id}
                sessionId={session.id}
                currentMode={session.mode}
                requestedAt={formatInTimeZone(session.startAt, actor.timeZone, "yyyy-MM-dd HH:mm")}
                completed={session.endAt !== null}
                hasPendingRequest={pendingSessionIds.has(session.id)}
              />
            ))}
          </div>
        )}
      </section>

      {records.length === 0 ? (
        <section role="status" className="rounded-lg border border-[var(--line)] bg-white px-4 py-8 text-center">
          <h2 className="text-base font-semibold">No eligible attendance records</h2>
          <p className="mt-2 text-sm text-[var(--muted)]">
            There are no calculated attendance records available for correction with an active assigned supervisor.
          </p>
        </section>
      ) : (
        <section aria-label="Attendance records available for correction" className="grid gap-4">
          {records.map((record) => (
            <AttendanceCorrectionRequestForm
              key={record.id}
              dailyAttendanceId={record.id}
              date={formatInTimeZone(record.date, "UTC", "yyyy-MM-dd")}
              status={record.status}
              firstIn={record.firstIn ? formatInTimeZone(record.firstIn, actor.timeZone, "yyyy-MM-dd HH:mm") : ""}
              lastOut={record.lastOut ? formatInTimeZone(record.lastOut, actor.timeZone, "yyyy-MM-dd HH:mm") : ""}
              timeZone={actor.timeZone}
              hasPendingRequest={pendingDailyAttendanceIds.has(record.id)}
            />
          ))}
        </section>
      )}

      <section aria-labelledby="correction-history-title" className="space-y-4">
        <div>
          <h2 id="correction-history-title" className="text-lg font-semibold">Your correction requests</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">Requests and decisions for your attendance only.</p>
        </div>
        {history.length === 0 ? (
          <p role="status" className="rounded-lg border border-[var(--line)] bg-white px-4 py-6 text-sm text-[var(--muted)]">
            You have not submitted any attendance correction requests.
          </p>
        ) : (
          <ol className="space-y-3">
            {history.map((request) => (
              <li key={request.id} className="rounded-lg border border-[var(--line)] bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">
                      Attendance date {request.attendanceDate
                        ? formatInTimeZone(request.attendanceDate, "UTC", "yyyy-MM-dd")
                        : request.dailyAttendance
                        ? formatInTimeZone(request.dailyAttendance.date, "UTC", "yyyy-MM-dd")
                        : request.session
                          ? formatInTimeZone(request.session.startAt, actor.timeZone, "yyyy-MM-dd")
                          : "unavailable"}
                    </h3>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      Submitted {formatInTimeZone(request.requestedAt, actor.timeZone, "yyyy-MM-dd HH:mm")}
                      {request.reviewedAt
                        ? ` · Reviewed ${formatInTimeZone(request.reviewedAt, actor.timeZone, "yyyy-MM-dd HH:mm")}`
                        : ""}
                      {request.reviewedBy ? ` · ${request.reviewedBy.name}` : ""}
                    </p>
                  </div>
                  <span className="rounded-sm bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
                    {request.status.replaceAll("_", " ")}
                  </span>
                </div>
                <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs font-semibold text-[var(--muted)]">Submitted values</dt>
                    <dd className="mt-1 whitespace-pre-wrap break-words text-sm">{readableValues(request.requestedValues)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold text-[var(--muted)]">Request reason</dt>
                    <dd className="mt-1 whitespace-pre-wrap text-sm">{request.reason}</dd>
                  </div>
                  {request.decisionNote && (
                    <div>
                      <dt className="text-xs font-semibold text-[var(--muted)]">Decision note</dt>
                      <dd className="mt-1 whitespace-pre-wrap text-sm">{request.decisionNote}</dd>
                    </div>
                  )}
                  {request.resolutionReason && (
                    <div>
                      <dt className="text-xs font-semibold text-[var(--muted)]">Resolution reason</dt>
                      <dd className="mt-1 whitespace-pre-wrap text-sm">{request.resolutionReason}</dd>
                    </div>
                  )}
                </dl>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
