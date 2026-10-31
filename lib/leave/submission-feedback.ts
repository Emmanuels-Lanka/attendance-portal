export function leaveRequestSubmissionRedirect(refreshSucceeded: boolean) {
  return refreshSucceeded
    ? "/leave?success=request-submitted"
    : "/leave?success=request-submitted&refresh=failed";
}

export function leaveRequestFeedback(success?: string, refreshStatus?: string) {
  return {
    showSuccess: success === "request-submitted",
    showRefreshWarning: refreshStatus === "failed",
  };
}
