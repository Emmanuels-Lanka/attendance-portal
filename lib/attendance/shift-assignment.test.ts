import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isOptionalSriLankanSaturday, resolveShiftForDate, type EffectiveShiftAssignment } from "./shift-assignment";

function assignment(
  id: string,
  workingDays: string[],
  effectiveFrom: string,
  effectiveTo: string | null = null,
): EffectiveShiftAssignment {
  return {
    effectiveFrom,
    effectiveTo,
    shift: {
      id,
      startTime: new Date("1970-01-01T08:00:00.000Z"),
      endTime: new Date("1970-01-01T17:00:00.000Z"),
      gracePeriodMinutes: 10,
      workingDays,
    },
  };
}

describe("effective shift resolution", () => {
  it("identifies optional Sri Lankan Saturdays by employee-local calendar date only", () => {
    assert.equal(isOptionalSriLankanSaturday("LK", "2026-10-24"), true);
    assert.equal(isOptionalSriLankanSaturday("LK", "2026-10-23"), false);
    assert.equal(isOptionalSriLankanSaturday("BD", "2026-10-24"), false);
    assert.equal(isOptionalSriLankanSaturday("LK", "invalid"), false);
  });

  it("selects the weekday/weekend shift by employee-local calendar date", () => {
    const assignments = [
      assignment("weekday", ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"], "2026-01-01"),
      assignment("saturday", ["SATURDAY"], "2026-01-01"),
    ];
    assert.deepEqual(resolveShiftForDate(assignments, "2026-06-19"), { kind: "ASSIGNED", shift: assignments[0].shift });
    assert.deepEqual(resolveShiftForDate(assignments, "2026-06-20"), { kind: "ASSIGNED", shift: assignments[1].shift });
    assert.equal(resolveShiftForDate(assignments, "2026-06-21").kind, "NON_WORKING_DAY");
  });

  it("keeps Saturday and Sunday assigned for the configured Bangladesh schedule", () => {
    const bangladesh = [assignment(
      "bangladesh",
      ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "SATURDAY", "SUNDAY"],
      "2026-01-01",
    )];
    assert.equal(resolveShiftForDate(bangladesh, "2026-10-24").kind, "ASSIGNED");
    assert.equal(resolveShiftForDate(bangladesh, "2026-10-25").kind, "ASSIGNED");
  });

  it("uses the assignment effective on a historical date rather than the current assignment", () => {
    const historical = assignment("old", ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"], "2026-01-01", "2026-03-31");
    const current = assignment("new", ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"], "2026-04-01");
    assert.deepEqual(resolveShiftForDate([historical, current], "2026-03-02"), { kind: "ASSIGNED", shift: historical.shift });
    assert.deepEqual(resolveShiftForDate([historical, current], "2026-04-06"), { kind: "ASSIGNED", shift: current.shift });
  });

  it("reports missing and ambiguous schedules instead of silently choosing one", () => {
    assert.deepEqual(resolveShiftForDate([], "2026-06-15"), { kind: "MISSING_ASSIGNMENT" });
    assert.equal(
      resolveShiftForDate([
        assignment("weekday-1", ["MONDAY"], "2026-01-01"),
        assignment("weekday-2", ["MONDAY"], "2026-01-01"),
      ], "2026-06-15").kind,
      "AMBIGUOUS",
    );
  });

  it("keeps an assignment's end date inclusive and rejects missing weekday configuration", () => {
    const ending = assignment("ending", ["MONDAY"], "2026-01-01", "2026-06-15");
    assert.equal(resolveShiftForDate([ending], "2026-06-15").kind, "ASSIGNED");
    assert.equal(resolveShiftForDate([ending], "2026-06-16").kind, "MISSING_ASSIGNMENT");
    assert.equal(resolveShiftForDate([assignment("unset-days", [], "2026-01-01")], "2026-06-15").kind, "UNCONFIGURED_WORKING_DAYS");
  });
});
