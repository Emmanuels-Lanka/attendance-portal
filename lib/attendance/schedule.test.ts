import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromZonedTime } from "date-fns-tz";
import { assessAttendanceArrival, assessDirector08Arrival, classifyAttendancePunch, type AttendanceShiftSchedule } from "./schedule";

function zonedInstant(date: string, time: string, timeZone: string) {
  const [clock, milliseconds = "000"] = time.split(".");
  const localTime = clock.length === 5 ? `${clock}:00` : clock;
  return fromZonedTime(`${date}T${localTime}.${milliseconds.padEnd(3, "0")}`, timeZone);
}

function shift(start: string, end: string, workingDays: string[]): AttendanceShiftSchedule {
  return {
    startTime: new Date(`1970-01-01T${start}:00.000Z`),
    endTime: new Date(`1970-01-01T${end}:00.000Z`),
    gracePeriodMinutes: 10,
    workingDays,
  };
}

const sriLankaWeekday = shift("08:00", "17:30", ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"]);
const sriLankaSaturday = shift("08:30", "13:30", ["SATURDAY"]);
const bangladeshShift = shift("08:00", "18:00", ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "SATURDAY", "SUNDAY"]);

describe("configured shift attendance rules", () => {
  it("applies the director 08:00 arrival windows and monthly grace allowance boundary", () => {
    const cases = [
      ["07:30:00", 0, "EARLY_ARRIVAL", 0, false],
      ["08:00:00", 0, "ON_TIME", 0, false],
      ["08:30:00", 0, "ON_TIME", 0, false],
      ["08:30:00.001", 0, "ON_TIME", 0, true],
      ["08:35:00", 1, "ON_TIME", 0, true],
      ["08:40:00", 2, "LATE", 10, false],
      ["08:40:00.001", 0, "UNDETERMINED", null, false],
      ["09:30:00", 0, "UNDETERMINED", null, false],
      ["09:30:00.001", 0, "LATE", 1, false],
    ] as const;

    for (const [time, used, classification, lateMinutes, consumesGraceAllowance] of cases) {
      assert.deepEqual(
        assessDirector08Arrival(zonedInstant("2026-06-15", time, "Asia/Colombo"), "Asia/Colombo", sriLankaWeekday, used),
        { classification, lateMinutes, consumesGraceAllowance },
        time,
      );
    }
  });

  it("keeps the 08:00 policy bounded to shifts that start at 08:00", () => {
    const weekendArrival = zonedInstant("2026-06-20", "08:35:00", "Asia/Colombo");

    assert.equal(
      assessDirector08Arrival(weekendArrival, "Asia/Colombo", sriLankaSaturday, 2).classification,
      "UNDETERMINED",
    );
  });

  it("uses local wall-clock time on daylight-saving transition dates", () => {
    const sundayShift = { ...sriLankaWeekday, workingDays: ["SUNDAY"] };
    const arrival = zonedInstant("2026-03-08", "09:30:00.001", "America/New_York");

    assert.deepEqual(
      assessDirector08Arrival(arrival, "America/New_York", sundayShift, 0),
      { classification: "LATE", lateMinutes: 1, consumesGraceAllowance: false },
    );
  });

  it("applies the full start/grace boundary table for an 08:00 shift", () => {
    const expected = new Map([
      ["07:59:59", "EARLY_ARRIVAL"],
      ["08:00:00", "ON_TIME"],
      ["08:09:59", "ON_TIME"],
      ["08:10:00", "ON_TIME"],
      ["08:10:01", "LATE"],
      ["08:30:00", "LATE"],
      ["08:30:01", "LATE"],
    ]);
    for (const [time, classification] of expected) {
      assert.equal(
        assessAttendanceArrival(zonedInstant("2026-06-15", time, "Asia/Colombo"), "Asia/Colombo", sriLankaWeekday).classification,
        classification,
        time,
      );
    }
  });

  it("rounds any positive fractional late minute up for the stored duration", () => {
    assert.deepEqual(
      assessAttendanceArrival(zonedInstant("2026-06-15", "08:10:01", "Asia/Colombo"), "Asia/Colombo", sriLankaWeekday),
      { classification: "LATE", lateMinutes: 1 },
    );
    assert.deepEqual(
      assessAttendanceArrival(zonedInstant("2026-06-15", "08:11:00", "Asia/Colombo"), "Asia/Colombo", sriLankaWeekday),
      { classification: "LATE", lateMinutes: 1 },
    );
  });

  it("uses the configured 08:30 Saturday shift rather than the weekday start", () => {
    const atGraceEnd = zonedInstant("2026-06-20", "08:40:00", "Asia/Colombo");
    const afterGrace = zonedInstant("2026-06-20", "08:40:01", "Asia/Colombo");
    assert.equal(classifyAttendancePunch("IN", atGraceEnd, "Asia/Colombo", sriLankaSaturday), "ON_TIME");
    assert.equal(classifyAttendancePunch("IN", afterGrace, "Asia/Colombo", sriLankaSaturday), "LATE");
    assert.equal(classifyAttendancePunch("IN", atGraceEnd, "Asia/Colombo", sriLankaWeekday), "NON_WORKING_DAY");
  });

  it("treats the 30-minute late threshold as separate from the grace-based late onset", () => {
    const oneSecondPastGrace = zonedInstant("2026-06-15", "08:10:01", "Asia/Colombo");
    const thirtyMinutesLate = zonedInstant("2026-06-15", "08:30:00", "Asia/Colombo");
    assert.equal(classifyAttendancePunch("IN", oneSecondPastGrace, "Asia/Colombo", sriLankaWeekday), "LATE");
    assert.equal(classifyAttendancePunch("IN", thirtyMinutesLate, "Asia/Colombo", sriLankaWeekday), "LATE");
  });

  it("classifies 08:10:00.001 as late for an 08:00 start and ten-minute grace", () => {
    assert.deepEqual(
      assessAttendanceArrival(zonedInstant("2026-06-15", "08:10:00.001", "Asia/Colombo"), "Asia/Colombo", sriLankaWeekday),
      { classification: "LATE", lateMinutes: 1 },
    );
  });

  it("applies identical timing policy to WFH and office punches", () => {
    const time = zonedInstant("2026-06-15", "08:10:01", "Asia/Colombo");
    assert.equal(classifyAttendancePunch("IN", time, "Asia/Colombo", sriLankaWeekday), "LATE");
    assert.equal(classifyAttendancePunch("WFH_IN", time, "Asia/Colombo", sriLankaWeekday), "LATE");
    assert.equal(
      classifyAttendancePunch("WFH_OUT", zonedInstant("2026-06-15", "17:00:00", "Asia/Colombo"), "Asia/Colombo", sriLankaWeekday),
      "EARLY_DEPARTURE",
    );
  });

  it("uses each employee's timezone to determine the local weekday and shift boundary", () => {
    assert.equal(classifyAttendancePunch("IN", zonedInstant("2026-06-15", "08:10:00", "Asia/Colombo"), "Asia/Colombo", sriLankaWeekday), "ON_TIME");
    assert.equal(classifyAttendancePunch("IN", zonedInstant("2026-06-15", "08:10:01", "Asia/Dhaka"), "Asia/Dhaka", bangladeshShift), "LATE");
    assert.equal(classifyAttendancePunch("IN", zonedInstant("2026-03-08", "08:10:00", "America/New_York"), "America/New_York", {
      ...sriLankaWeekday,
      workingDays: ["SUNDAY"],
    }), "ON_TIME");
  });

  it("covers the configured Bangladesh and Sri Lanka weekday/weekend shift schedules", () => {
    assert.equal(classifyAttendancePunch("IN", zonedInstant("2026-06-21", "08:10", "Asia/Dhaka"), "Asia/Dhaka", bangladeshShift), "ON_TIME");
    assert.equal(classifyAttendancePunch("OUT", zonedInstant("2026-06-21", "18:00", "Asia/Dhaka"), "Asia/Dhaka", bangladeshShift), "NORMAL");
    assert.equal(classifyAttendancePunch("IN", zonedInstant("2026-06-19", "08:10", "Asia/Dhaka"), "Asia/Dhaka", bangladeshShift), "NON_WORKING_DAY");
    assert.equal(classifyAttendancePunch("IN", zonedInstant("2026-06-19", "08:10", "Asia/Colombo"), "Asia/Colombo", sriLankaWeekday), "ON_TIME");
    assert.equal(classifyAttendancePunch("IN", zonedInstant("2026-06-20", "08:40", "Asia/Colombo"), "Asia/Colombo", sriLankaSaturday), "ON_TIME");
    assert.equal(classifyAttendancePunch("OUT", zonedInstant("2026-06-20", "13:30", "Asia/Colombo"), "Asia/Colombo", sriLankaSaturday), "NORMAL");
  });

  it("uses the assigned end time for departure and leaves missing configuration unresolved", () => {
    assert.equal(classifyAttendancePunch("OUT", zonedInstant("2026-06-15", "17:00:00", "Asia/Colombo"), "Asia/Colombo", sriLankaWeekday), "EARLY_DEPARTURE");
    assert.equal(classifyAttendancePunch("OUT", zonedInstant("2026-06-15", "17:30:00", "Asia/Colombo"), "Asia/Colombo", sriLankaWeekday), "NORMAL");
    assert.equal(classifyAttendancePunch("IN", zonedInstant("2026-06-15", "08:30:00", "Asia/Colombo"), "Asia/Colombo", null), "UNDETERMINED");
    assert.equal(classifyAttendancePunch("IN", zonedInstant("2026-06-15", "08:30:00", "Asia/Colombo"), "Asia/Colombo", {
      ...sriLankaWeekday,
      gracePeriodMinutes: null,
    }), "UNDETERMINED");
    assert.equal(classifyAttendancePunch("IN", zonedInstant("2026-06-15", "08:30:00", "Asia/Colombo"), "Asia/Colombo", {
      ...sriLankaWeekday,
      workingDays: [],
    }), "UNDETERMINED");
    assert.equal(classifyAttendancePunch("OUT", zonedInstant("2026-06-15", "17:00:00", "Asia/Colombo"), "Asia/Colombo", {
      ...sriLankaWeekday,
      endTime: new Date("1970-01-01T07:00:00.000Z"),
    }), "UNDETERMINED");
  });
});
