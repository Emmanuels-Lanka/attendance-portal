import assert from "node:assert/strict";
import { it } from "node:test";
import { leaveRequestFeedback, leaveRequestSubmissionRedirect } from "./submission-feedback";

it("keeps leave submission success visible when cache refresh fails", () => {
  const redirect = leaveRequestSubmissionRedirect(false);
  const search = new URLSearchParams(redirect.split("?")[1]);
  const feedback = leaveRequestFeedback(search.get("success") ?? undefined, search.get("refresh") ?? undefined);

  assert.equal(search.get("success"), "request-submitted");
  assert.equal(search.get("refresh"), "failed");
  assert.equal(feedback.showSuccess, true);
  assert.equal(feedback.showRefreshWarning, true);

  const refreshedRedirect = leaveRequestSubmissionRedirect(true);
  const refreshedSearch = new URLSearchParams(refreshedRedirect.split("?")[1]);
  assert.deepEqual(
    leaveRequestFeedback(refreshedSearch.get("success") ?? undefined, refreshedSearch.get("refresh") ?? undefined),
    { showSuccess: true, showRefreshWarning: false },
  );
});
