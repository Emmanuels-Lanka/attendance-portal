import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupSessionsByEmployeeLocalDay, monthlyGraceAllowancesUsedBeforeEachDate, type AttendanceSession } from "./history";
import type { EffectiveShiftAssignment } from "./shift-assignment";

function session(id: string, mode: AttendanceSession["mode"], startAt: string, endAt: string | null): AttendanceSession {
  return { id, mode, startAt: new Date(startAt), endAt: endAt ? new Date(endAt) : null };
}

const assignments: EffectiveShiftAssignment[] = [
  {
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    shift: {
      id: "weekday",
      startTime: new Date("1970-01-01T08:00:00.000Z"),
      endTime: new Date("1970-01-01T17:30:00.000Z"),
      gracePeriodMinutes: 10,
      workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
    },
  },
  {
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    shift: {
      id: "saturday",
      startTime: new Date("1970-01-01T08:30:00.000Z"),
      endTime: new Date("1970-01-01T13:30:00.000Z"),
      gracePeriodMinutes: 10,
      workingDays: ["SATURDAY"],
    },
  },
];

describe("employee-local attendance history", () => {
  it("counts one shared monthly allowance per local workday across assigned 08:00 shifts", () => {
    const shiftAssignments: EffectiveShiftAssignment[] = [
      {
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        shift: {
          id: "weekday",
          startTime: new Date("1970-01-01T08:00:00.000Z"),
          endTime: new Date("1970-01-01T17:30:00.000Z"),
          gracePeriodMinutes: 41,
          workingDays: ["MONDAY", "TUESDAY"],
        },
      },
      {
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        shift: {
          id: "alternate-08",
          startTime: new Date("1970-01-01T08:00:00.000Z"),
          endTime: new Date("1970-01-01T18:00:00.000Z"),
          gracePeriodMinutes: 10,
          workingDays: ["WEDNESDAY", "THURSDAY"],
        },
      },
    ];
    const sessions = [
      session("monday-in", "OFFICE", "2026-06-15T03:05:00.000Z", null),
      session("monday-reentry", "OFFICE", "2026-06-15T06:00:00.000Z", null),
      session("tuesday-in", "WFH", "2026-06-16T03:05:00.000Z", null),
      session("wednesday-in", "OFFICE", "2026-06-17T03:05:00.000Z", null),
      session("thursday-in", "OFFICE", "2026-06-18T03:05:00.000Z", null),
    ];

    const allowances = monthlyGraceAllowancesUsedBeforeEachDate(sessions, "Asia/Colombo", shiftAssignments);

    assert.equal(allowances.get("2026-06-15"), 0);
    assert.equal(allowances.get("2026-06-16"), 1);
    assert.equal(allowances.get("2026-06-17"), 2);
    assert.equal(allowances.get("2026-06-18"), 2);
  });

  it("resets the monthly allowance count at the employee-local month boundary", () => {
    const tokyoShift: EffectiveShiftAssignment[] = [{
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      shift: {
        id: "tokyo-08",
        startTime: new Date("1970-01-01T08:00:00.000Z"),
        endTime: new Date("1970-01-01T17:00:00.000Z"),
        gracePeriodMinutes: 0,
        workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY"],
      },
    }];
    const allowances = monthlyGraceAllowancesUsedBeforeEachDate([
      session("june-first", "OFFICE", "2026-06-28T23:35:00.000Z", null),
      session("june-second", "OFFICE", "2026-06-29T23:35:00.000Z", null),
      session("july", "OFFICE", "2026-06-30T23:35:00.000Z", null),
    ], "Asia/Tokyo", tokyoShift);

    assert.equal(allowances.get("2026-06-29"), 0);
    assert.equal(allowances.get("2026-06-30"), 1);
    assert.equal(allowances.get("2026-07-01"), 0);
  });

  it("groups every multiple and mixed Office/WFH session by employee-local start date", () => {
    const history = groupSessionsByEmployeeLocalDay([
      session("office-1", "OFFICE", "2026-06-15T02:30:00Z", "2026-06-15T06:30:00Z"),
      session("wfh-1", "WFH", "2026-06-15T08:00:00Z", "2026-06-15T12:00:00Z"),
      session("office-2", "OFFICE", "2026-06-15T17:00:00Z", null),
      session("next-day", "WFH", "2026-06-16T19:00:00Z", "2026-06-16T20:00:00Z"),
    ], "Asia/Colombo");

    assert.deepEqual(history.days.map((day) => day.date), ["2026-06-17", "2026-06-15"]);
    const june15 = history.days[1];
    assert.deepEqual(june15.sessions.map(({ session: item }) => item.id), ["office-1", "wfh-1", "office-2"]);
    assert.deepEqual(june15.sessions.map(({ session: item }) => item.mode), ["OFFICE", "WFH", "OFFICE"]);
    assert.equal(june15.sessions[2].status, "ACTIVE");
  });

  it("sums completed session durations and excludes active sessions", () => {
    const history = groupSessionsByEmployeeLocalDay([
      session("office", "OFFICE", "2026-06-15T02:30:00Z", "2026-06-15T06:30:00Z"),
      session("wfh", "WFH", "2026-06-15T08:00:00Z", "2026-06-15T12:00:00Z"),
      session("active", "OFFICE", "2026-06-15T13:00:00Z", null),
    ], "Asia/Colombo");

    assert.equal(history.days[0].totalWorkedMs, 8 * 60 * 60 * 1000);
    assert.equal(history.days[0].sessions[2].durationMs, null);
    assert.equal(history.days[0].sessions[2].status, "ACTIVE");
  });

  it("uses the employee-local calendar date when the UTC date differs", () => {
    const history = groupSessionsByEmployeeLocalDay([
      session("midnight", "OFFICE", "2026-06-15T18:30:00Z", "2026-06-15T19:00:00Z"),
    ], "Asia/Colombo");

    assert.equal(history.days[0].date, "2026-06-16");
  });

  it("keeps invalid or incomplete timestamps out of worked totals", () => {
    const history = groupSessionsByEmployeeLocalDay([
      session("invalid-end", "WFH", "2026-06-15T02:30:00Z", "2026-06-15T01:30:00Z"),
      session("malformed-end", "OFFICE", "2026-06-15T02:45:00Z", "not-a-date"),
      session("active", "OFFICE", "2026-06-15T03:00:00Z", null),
      { id: "invalid-start", mode: "OFFICE", startAt: new Date("invalid"), endAt: null },
    ], "Asia/Dhaka");

    assert.equal(history.invalidSessions, 1);
    assert.equal(history.days[0].sessions[0].status, "INVALID");
    assert.equal(history.days[0].sessions[1].status, "INVALID");
    assert.equal(history.days[0].totalWorkedMs, 0);
  });

  it("classifies office and WFH sessions using the applicable weekday or weekend shift", () => {
    const history = groupSessionsByEmployeeLocalDay([
      session("office-on-time", "OFFICE", "2026-06-15T02:40:00.000Z", "2026-06-15T12:30:00.000Z"),
      session("wfh-late", "WFH", "2026-06-15T02:40:01.000Z", "2026-06-15T12:30:00.000Z"),
      session("saturday", "OFFICE", "2026-06-20T03:10:01.000Z", "2026-06-20T08:00:00.000Z"),
    ], "Asia/Colombo", assignments);

    const sessions = new Map(history.days.flatMap((day) => day.sessions.map((item) => [item.session.id, item] as const)));
    assert.equal(sessions.get("office-on-time")?.timing?.arrival, "ON_TIME");
    assert.equal(sessions.get("wfh-late")?.timing?.arrival, "ON_TIME");
    assert.equal(sessions.get("saturday")?.timing?.arrival, "LATE");
  });

  it("does not infer a WFH or office schedule when no effective assignment exists", () => {
    const history = groupSessionsByEmployeeLocalDay([
      session("unassigned", "WFH", "2026-06-15T02:40:00.000Z", null),
    ], "Asia/Colombo");
    assert.equal(history.days[0].sessions[0].timing?.arrival, "UNDETERMINED");
  });

  it("resolves the OUT shift from the OUT event's local date", () => {
    const history = groupSessionsByEmployeeLocalDay([
      session("cross-day", "WFH", "2026-06-20T03:10:00.000Z", "2026-06-21T03:30:00.000Z"),
    ], "Asia/Colombo", assignments);
    assert.equal(history.days[0].sessions[0].timing?.arrival, "ON_TIME");
    assert.equal(history.days[0].sessions[0].timing?.departure, "NON_WORKING_DAY");
  });

  it("leaves Sri Lankan Saturday punches undetermined when no Saturday shift applies", () => {
    const weekdayOnly = [{
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
    const history = groupSessionsByEmployeeLocalDay([
      session("saturday", "OFFICE", "2026-10-23T18:35:00.000Z", "2026-10-23T22:00:00.000Z"),
    ], "Asia/Colombo", weekdayOnly, "LK");
    assert.equal(history.days[0].date, "2026-10-24");
    assert.equal(history.days[0].sessions[0].timing?.arrival, "UNDETERMINED");
    assert.equal(history.days[0].sessions[0].timing?.departure, "UNDETERMINED");
  });
});