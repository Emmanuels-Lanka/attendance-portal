import assert from "node:assert/strict";
import { it } from "node:test";
import { completeAttendanceAction } from "./action-completion";

it("reports a saved attendance action when page revalidation fails", () => {
  const revalidationError = new Error("cache unavailable");
  const reportedErrors: unknown[] = [];

  const result = completeAttendanceAction(
    null,
    () => {
      throw revalidationError;
    },
    (error) => reportedErrors.push(error),
  );

  assert.equal(result.ok, true);
  assert.match(result.message, /^Attendance updated\./);
  assert.match(result.message, /Reload to see the latest status/);
  assert.deepEqual(reportedErrors, [revalidationError]);
});

it("preserves attendance calculation warnings after successful revalidation", () => {
  const result = completeAttendanceAction(
    "Daily attendance could not be recalculated.",
    () => {},
    () => assert.fail("No revalidation error was expected"),
  );

  assert.equal(result.ok, true);
  assert.equal(result.message, "Attendance updated. Daily attendance could not be recalculated.");
});
