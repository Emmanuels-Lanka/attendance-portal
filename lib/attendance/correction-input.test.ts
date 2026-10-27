import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DailyAttendanceCorrectionInvalidValuesError } from "./correction-service";
import { attendanceCorrectionInstant } from "./correction-input";

describe("attendance correction form timestamps", () => {
  it("converts employee-local wall time to the expected UTC instant", () => {
    assert.equal(
      attendanceCorrectionInstant("2026-10-05T08:30", "Asia/Colombo", "2026-10-05"),
      "2026-10-05T03:00:00.000Z",
    );
  });

  it("rejects timestamps outside the selected employee-local date", () => {
    assert.throws(
      () => attendanceCorrectionInstant("2026-10-06T00:15", "Asia/Colombo", "2026-10-05"),
      (error: unknown) => error instanceof DailyAttendanceCorrectionInvalidValuesError
        && error.message.includes("selected employee-local attendance date"),
    );
  });

  it("rejects impossible dates and nonexistent daylight-saving local times", () => {
    for (const [value, timeZone] of [
      ["2026-02-30T08:30", "Asia/Colombo"],
      ["2026-03-08T02:30", "America/New_York"],
    ]) {
      assert.throws(
        () => attendanceCorrectionInstant(value, timeZone),
        DailyAttendanceCorrectionInvalidValuesError,
      );
    }
  });

  it("preserves seconds when the form includes them", () => {
    assert.equal(
      attendanceCorrectionInstant("2026-10-05T08:30:45", "Asia/Colombo", "2026-10-05"),
      "2026-10-05T03:00:45.000Z",
    );
  });
});
