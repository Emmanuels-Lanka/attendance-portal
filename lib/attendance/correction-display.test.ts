import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  correctionDisplayTimeZone,
  formatCorrectionCalendarDate,
  formatCorrectionJsonForDisplay,
  formatCorrectionTimestamp,
} from "./correction-display";

describe("attendance correction display formatting", () => {
  it("formats instants in the configured Colombo and Dhaka timezones", () => {
    const instant = new Date("2026-10-23T12:30:00.000Z");
    assert.equal(formatCorrectionTimestamp(instant, "Asia/Colombo"), "2026-10-23 18:00:00 +05:30 (Asia/Colombo)");
    assert.equal(formatCorrectionTimestamp(instant, "Asia/Dhaka"), "2026-10-23 18:30:00 +06:00 (Asia/Dhaka)");
  });

  it("uses IANA daylight-saving rules and includes the applicable offset", () => {
    assert.equal(
      formatCorrectionTimestamp("2026-07-01T12:00:00.000Z", "America/New_York"),
      "2026-07-01 08:00:00 -04:00 (America/New_York)",
    );
    assert.equal(
      formatCorrectionTimestamp("2026-01-01T12:00:00.000Z", "America/New_York"),
      "2026-01-01 07:00:00 -05:00 (America/New_York)",
    );
  });

  it("falls back to UTC for missing or invalid configured timezones", () => {
    assert.equal(correctionDisplayTimeZone(undefined), "UTC");
    assert.equal(correctionDisplayTimeZone("Mars/Olympus"), "UTC");
    assert.equal(formatCorrectionTimestamp("2026-10-23T12:30:00.000Z", "Mars/Olympus"), "2026-10-23 12:30:00 Z (UTC)");
    assert.equal(formatCorrectionTimestamp(null, "Asia/Colombo"), "—");
    assert.equal(formatCorrectionTimestamp("not a timestamp", "Asia/Colombo"), "—");
  });

  it("preserves date-only calendar values rather than shifting them as instants", () => {
    assert.equal(formatCorrectionCalendarDate(new Date("2026-10-05T00:00:00.000Z"), "America/Los_Angeles"), "2026-10-04");
    const displayed = formatCorrectionJsonForDisplay({ attendanceDate: "2026-10-05" }, "America/Los_Angeles");
    assert.equal(displayed, '{\n  "attendanceDate": "2026-10-05"\n}');
  });

  it("formats nested ISO timestamps in JSON without mutating source evidence", () => {
    const evidence = {
      firstIn: "2026-10-23T12:30:00.000Z",
      metadata: [{ endAt: "2026-10-23T13:00:00+00:00", note: "unchanged" }],
      mode: "OFFICE",
      reason: "2026-10-23T12:30:00.000Z",
      identifier: "session-123",
    };
    const before = structuredClone(evidence);
    const display = formatCorrectionJsonForDisplay(evidence, "Asia/Colombo");

    assert.match(display, /2026-10-23 18:00:00 \+05:30 \(Asia\/Colombo\)/);
    assert.match(display, /2026-10-23 18:30:00 \+05:30 \(Asia\/Colombo\)/);
    assert.match(display, /"note": "unchanged"/);
    assert.match(display, /"mode": "OFFICE"/);
    assert.match(display, /"reason": "2026-10-23T12:30:00.000Z"/);
    assert.match(display, /"identifier": "session-123"/);
    assert.deepEqual(evidence, before);
    assert.equal(formatCorrectionJsonForDisplay(null, "Asia/Dhaka"), "—");
    assert.equal(formatCorrectionJsonForDisplay(undefined, "Asia/Dhaka"), "—");
    assert.equal(formatCorrectionJsonForDisplay("legacy payload", "Asia/Dhaka"), '"legacy payload"');
  });

  it("shares identical formatting behavior for report and approval queue instants", () => {
    const requestTimestamp = new Date("2026-10-23T12:30:00.000Z");
    assert.equal(
      formatCorrectionTimestamp(requestTimestamp, "Asia/Dhaka"),
      formatCorrectionTimestamp(requestTimestamp, "Asia/Dhaka"),
    );
  });
});
