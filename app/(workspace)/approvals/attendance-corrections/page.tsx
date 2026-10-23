import { formatInTimeZone } from "date-fns-tz";
import { redirect } from "next/navigation";
import { AttendanceCorrectionApprovalStage } from "@prisma/client";
import { AttendanceCorrectionReviewForm } from "@/components/attendance-correction-review-form";
import { listDailyAttendanceCorrections } from "@/lib/attendance/correction-service";
import { requirePageUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";

function readableValues(value: unknown) {
  return value === null || value === undefined ? "—" : JSON.stringify(value, null, 2);
}

function timeLabel(value: Date | null) {
  return value ? formatInTimeZone(value, "UTC", "yyyy-MM-dd HH:mm:ss 'UTC'") : "—";
}

export default async function AttendanceCorrectionApprovalsPage() {
  const actor = await requirePageUser();
  if (
    (actor.role !== "SUPERVISOR" && actor.role !== "HR_ADMINISTRATOR")
    || !hasPermission(actor.role, "attendance:correction:approve")
  ) {
    redirect("/dashboard");
  }
  const corrections = await listDailyAttendanceCorrections(actor);
  const stage = actor.role === "SUPERVISOR"
    ? AttendanceCorrectionApprovalStage.SUPERVISOR
    : AttendanceCorrectionApprovalStage.HR;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium text-[var(--blue)]">Approvals</p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Attendance correction approvals</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          {stage === AttendanceCorrectionApprovalStage.SUPERVISOR ? "Corrections for employees assigned to you." : "Corrections awaiting final HR review."}
        </p>
      </header>
      {corrections.length === 0 ? (
        <p role="status" className="rounded-lg border border-[var(--line)] bg-white px-4 py-8 text-sm text-[var(--muted)]">No attendance corrections are awaiting your review.</p>
      ) : (
        <ol className="space-y-4">
          {corrections.map((correction) => (
            <li key={correction.id} className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">
                    {correction.dailyAttendance?.employee.name ?? correction.session?.record.employee.name ?? correction.employee.name}
                  </h2>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {correction.dailyAttendance?.employee.employeeId ?? correction.employee.employeeCode ?? "No employee ID"}
                    {" · "}
                    {correction.dailyAttendance
                      ? formatInTimeZone(correction.dailyAttendance.date, "UTC", "yyyy-MM-dd")
                      : correction.session
                        ? formatInTimeZone(correction.session.startAt, "UTC", "yyyy-MM-dd")
                        : "Attendance record unavailable"}
                    {" · "}
                    Requested {timeLabel(correction.requestedAt)}
                  </p>
                </div>
                <span className="rounded-sm bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
                  {stage === AttendanceCorrectionApprovalStage.SUPERVISOR ? "Supervisor review" : "HR review"}
                </span>
              </div>
              <p className="mt-4 text-sm"><span className="font-semibold">Request reason:</span> {correction.reason}</p>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div>
                  <h3 className="text-xs font-semibold text-[var(--muted)]">
                    {correction.sessionId ? "Original recorded session" : "Original calculated attendance"}
                  </h3>
                  <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 text-xs">{readableValues(correction.originalValues)}</pre>
                </div>
                <div>
                  <h3 className="text-xs font-semibold text-[var(--muted)]">Requested values</h3>
                  <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 text-xs">{readableValues(correction.requestedValues)}</pre>
                </div>
              </div>
              {!correction.dailyAttendance && !correction.session && <p role="alert" className="mt-3 text-sm text-[var(--danger)]">The attendance session or calculated record is unavailable; this request cannot be decided.</p>}
              {(correction.dailyAttendance || correction.session) && <div className="mt-4 border-t border-[var(--line)] pt-4"><AttendanceCorrectionReviewForm correctionRequestId={correction.id} /></div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
