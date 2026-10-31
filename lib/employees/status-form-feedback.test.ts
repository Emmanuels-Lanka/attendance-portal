import assert from "node:assert/strict";
import { it } from "node:test";
import { employeeStatusFormFeedback } from "./status-form-feedback";

it("keeps status changes pending, retryable after failure, and available after success", () => {
  const pending = employeeStatusFormFeedback(true, true, null);
  assert.equal(pending.buttonLabel, "Saving...");
  assert.equal(pending.disabled, true);

  const failed = employeeStatusFormFeedback(true, false, { error: "Update failed." });
  assert.equal(failed.buttonLabel, "Deactivate employee");
  assert.equal(failed.disabled, false);
  assert.equal(failed.error, "Update failed.");

  const retryPending = employeeStatusFormFeedback(true, true, { error: "Update failed." });
  assert.equal(retryPending.disabled, true);

  const deactivated = employeeStatusFormFeedback(false, false, {
    success: "Employee account deactivated.",
    isActive: false,
  });
  assert.equal(deactivated.buttonLabel, "Activate employee");
  assert.equal(deactivated.disabled, false);
  assert.equal(deactivated.success, "Employee account deactivated.");

  const waitingForRefresh = employeeStatusFormFeedback(true, false, {
    success: "Employee account deactivated.",
    isActive: false,
  });
  assert.equal(waitingForRefresh.disabled, true);
  assert.equal(waitingForRefresh.buttonLabel, "Refreshing...");
  assert.equal(employeeStatusFormFeedback(true, false, {
    success: "Employee account deactivated.",
    isActive: false,
  }, true).disabled, false);

  const secondChange = employeeStatusFormFeedback(false, false, {
    success: "Employee account deactivated.",
    isActive: false,
  });
  assert.equal(secondChange.buttonLabel, "Activate employee");
  assert.equal(secondChange.disabled, false);
});
