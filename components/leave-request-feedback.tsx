import React from "react";
import { leaveRequestFeedback } from "@/lib/leave/submission-feedback";

export function LeaveRequestFeedback({
  success,
  refreshStatus,
}: {
  success?: string;
  refreshStatus?: string;
}) {
  const feedback = leaveRequestFeedback(success, refreshStatus);
  return (
    <>
      {feedback.showSuccess && <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">Your Leave request was submitted and is pending review.</p>}
      {feedback.showRefreshWarning && <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">The change was saved, but the page could not refresh. Reload to see the latest status.</p>}
    </>
  );
}
