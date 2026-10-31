import { redirect } from "next/navigation";
import { AttendanceCorrectionApprovalStage } from "@prisma/client";
import { AttendanceCorrectionReviewForm } from "@/components/attendance-correction-review-form";
import { listDailyAttendanceCorrections } from "@/lib/attendance/correction-service";
import {
  correctionDisplayTimeZone,
  formatCorrectionEmployeeIdentifier,
  formatCorrectionCalendarDate,
  formatCorrectionJsonForDisplay,
  formatCorrectionTimestamp,
} from "@/lib/attendance/correction-display";
import { requirePageUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";

export default async function AttendanceCorrectionApprovalsPage() {
  const actor = await requirePageUser();
  if (
    (actor.role !== "SUPERVISOR" && actor.role !== "HR_ADMINISTRATOR" && actor.role !== "DEPARTMENT_MANAGER" && actor.role !== "ADMIN")
    || !hasPermission(actor.role, "attendance:correction:approve")
  ) {
    redirect("/dashboard");
  }
  const corrections = await listDailyAttendanceCorrections(actor);
  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium text-[var(--blue)]">Approvals</p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Attendance correction approvals</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          {actor.role === "SUPERVISOR"
            ? "Correction requests for employees assigned to you, at their current approval stage."
            : actor.role === "DEPARTMENT_MANAGER"
              ? "Correction requests for employees within your authorized department scope, at their current approval stage."
            : "Correction requests at their current approval stage."}
        </p>
      </header>
      {corrections.length === 0 ? (
        <p role="status" className="rounded-lg border border-[var(--line)] bg-white px-4 py-8 text-sm text-[var(--muted)]">No attendance corrections are awaiting your review.</p>
      ) : (
        <ol className="space-y-4">
          {corrections.map((correction) => {
            const isOwnRequest = correction.employeeId === actor.id || correction.requesterId === actor.id;
            const isHrSelfApproval = actor.role === "HR_ADMINISTRATOR"
              && correction.employeeId === actor.id
              && correction.requesterId === actor.id
              && correction.currentApprovalStage === AttendanceCorrectionApprovalStage.HR;
            return (
            <li key={correction.id} className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">
                    {correction.dailyAttendance?.employee.name ?? correction.session?.record.employee.name ?? correction.employee.name}
                  </h2>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {formatCorrectionEmployeeIdentifier({
                      attendanceEmployeeId: correction.dailyAttendance?.employee.employeeId,
                      employeeRecordId: correction.employee.employee?.employeeId,
                      employeeCode: correction.employee.employeeCode,
                    })}
                    {" · "}
                    {correction.attendanceDate
                      ? correction.attendanceDate.toISOString().slice(0, 10)
                      : correction.dailyAttendance
                      ? correction.dailyAttendance.date.toISOString().slice(0, 10)
                      : correction.session
                        ? formatCorrectionCalendarDate(correction.session.startAt, correction.employee.timeZone)
                        : "Attendance record unavailable"}
                    {" · "}
                    Requested {formatCorrectionTimestamp(correction.requestedAt, correction.employee.timeZone)}
                  </p>
                </div>
                <span className="rounded-sm bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
                  {correction.currentApprovalStage === AttendanceCorrectionApprovalStage.SUPERVISOR
                    ? "Supervisor review"
                    : "HR review"}
                </span>
              </div>
              <p className="mt-4 text-sm"><span className="font-semibold">Request reason:</span> {correction.reason}</p>
              {isOwnRequest && (
                <p role="status" className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  {isHrSelfApproval
                    ? "This is your own attendance correction. HR Administrators may approve their own request at HR review; rejection by the requester is not permitted."
                    : "This is your own attendance correction request. An independent reviewer must complete this review stage before you can approve it as HR."}
                </p>
              )}
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div>
                  <h3 className="text-xs font-semibold text-[var(--muted)]">
                    {correction.sessionId ? "Original recorded session" : "Original calculated attendance"}
                  </h3>
                  <p className="mt-1 text-[11px] text-[var(--muted)]">Instants formatted for {correctionDisplayTimeZone(correction.employee.timeZone)}; stored values are unchanged.</p>
                  <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 text-xs">{formatCorrectionJsonForDisplay(correction.originalValues, correction.employee.timeZone)}</pre>
                </div>
                <div>
                  <h3 className="text-xs font-semibold text-[var(--muted)]">Requested values</h3>
                  <p className="mt-1 text-[11px] text-[var(--muted)]">Instants formatted for {correctionDisplayTimeZone(correction.employee.timeZone)}; stored values are unchanged.</p>
                  <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 text-xs">{formatCorrectionJsonForDisplay(correction.requestedValues, correction.employee.timeZone)}</pre>
                </div>
              </div>
              {!correction.attendanceDate && !correction.dailyAttendance && !correction.session && <p role="alert" className="mt-3 text-sm text-[var(--danger)]">The attendance session or calculated record is unavailable; this request cannot be decided.</p>}
              {(correction.attendanceDate || correction.dailyAttendance || correction.session)
                && (!isOwnRequest || isHrSelfApproval)
                && <div className="mt-4 border-t border-[var(--line)] pt-4"><AttendanceCorrectionReviewForm correctionRequestId={correction.id} selfApprovalOnly={isHrSelfApproval} /></div>}
            </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
