import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sessionView } from "./admin-session-view";
import type { EffectiveShiftAssignment } from "./shift-assignment";

const weekdayOnlyAssignment: EffectiveShiftAssignment[] = [{
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  shift: {
    id: "weekday",
    startTime: new Date("1970-01-01T08:00:00.000Z"),
    endTime: new Date("1970-01-01T17:30:00.000Z"),
    gracePeriodMinutes: 10,
    workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
  },
}];

describe("Admin attendance session details", () => {
  it("leaves Sri Lankan optional Saturday work undetermined without an applicable Saturday shift", () => {
    const view = sessionView({
      id: "saturday-session",
      recordId: "attendance-record-lk",
      mode: "OFFICE",
      startAt: new Date("2026-10-23T18:35:00.000Z"),
      endAt: new Date("2026-10-23T22:00:00.000Z"),
      monthlyGraceAllowancesUsed: 0,
      createdAt: new Date("2026-10-23T18:35:00.000Z"),
      updatedAt: new Date("2026-10-23T22:00:00.000Z"),
      record: {
        employee: {
          id: "employee-lk",
          name: "Sri Lankan employee",
          employeeCode: "LK-001",
          email: "employee@example.invalid",
          role: "EMPLOYEE",
          isActive: true,
          countryCode: "LK",
          timeZone: "Asia/Colombo",
          employeeRecord: {
            id: "record-lk",
            name: "Sri Lankan employee",
            employeeId: "LK-001",
            shiftAssignments: weekdayOnlyAssignment,
          },
        },
      },
    });

    assert.equal(view.localDate, "2026-10-24");
    assert.equal(view.arrival, "UNDETERMINED");
    assert.equal(view.departure, "UNDETERMINED");
  });

  it("serializes effective employee-local timestamps with seconds for the correction form", () => {
    const view = sessionView({
      id: "precision-session",
      recordId: "attendance-record-precision",
      mode: "OFFICE",
      startAt: new Date("2026-10-23T18:35:47.000Z"),
      endAt: new Date("2026-10-24T11:00:29.000Z"),
      monthlyGraceAllowancesUsed: 0,
      createdAt: new Date("2026-10-23T18:35:47.000Z"),
      updatedAt: new Date("2026-10-24T11:00:29.000Z"),
      record: {
        employee: {
          id: "employee-precision",
          name: "Precision employee",
          employeeCode: "LK-002",
          email: "precision@example.invalid",
          role: "EMPLOYEE",
          isActive: true,
          countryCode: "LK",
          timeZone: "Asia/Colombo",
          employeeRecord: {
            id: "record-precision",
            name: "Precision employee",
            employeeId: "LK-002",
            shiftAssignments: weekdayOnlyAssignment,
          },
        },
      },
    });

    assert.equal(view.correctionStart, "2026-10-24T00:05:47");
    assert.equal(view.correctionEnd, "2026-10-24T16:30:29");
  });
});
