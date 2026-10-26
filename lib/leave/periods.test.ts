import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getHalfDayIntervals,
  getTimeLeaveInterval,
  LeaveScheduleConfigurationError,
  scheduledWorkingMinutes,
} from "./periods";

const shift = {
  startTime: new Date("1970-01-01T08:00:00.000Z"),
  endTime: new Date("1970-01-01T17:30:00.000Z"),
  gracePeriodMinutes: 0,
  breakDurationMinutes: 60,
};

describe("leave schedule periods", () => {
  it("splits net working time around a configured break without including the break", () => {
    const configured = { ...shift, breakStartTime: new Date("1970-01-01T12:30:00.000Z") };
    assert.equal(scheduledWorkingMinutes(configured), 510);
    const morning = getHalfDayIntervals("2026-10-26", "Asia/Colombo", configured, "MORNING");
    const afternoon = getHalfDayIntervals("2026-10-26", "Asia/Colombo", configured, "AFTERNOON");
    assert.deepEqual(morning.map(({ startAt, endAt }) => [
      startAt.toISOString().slice(11, 16),
      endAt.toISOString().slice(11, 16),
    ]), [["02:30", "06:45"]]);
    assert.deepEqual(afternoon.map(({ startAt, endAt }) => [
      startAt.toISOString().slice(11, 16),
      endAt.toISOString().slice(11, 16),
    ]), [["06:45", "07:00"], ["08:00", "12:00"]]);
  });

  it("blocks half-day boundaries when a configured break has no start time", () => {
    assert.throws(
      () => getHalfDayIntervals("2026-10-26", "Asia/Colombo", shift, "MORNING"),
      LeaveScheduleConfigurationError,
    );
    assert.throws(
      () => getTimeLeaveInterval("2026-10-26", "Asia/Colombo", shift, "09:00", "10:00"),
      LeaveScheduleConfigurationError,
    );
  });

  it("splits an unbroken shift into equal intervals and validates short leave boundaries", () => {
    const noBreak = { ...shift, breakDurationMinutes: 0 };
    const morning = getHalfDayIntervals("2026-10-26", "Asia/Colombo", noBreak, "MORNING");
    assert.equal(morning[0].endAt.toISOString().slice(11, 16), "07:15");
    const request = getTimeLeaveInterval("2026-10-26", "Asia/Colombo", noBreak, "09:00", "10:00");
    assert.equal(request.endAt.getTime() - request.startAt.getTime(), 60 * 60_000);
    assert.throws(
      () => getTimeLeaveInterval("2026-10-26", "Asia/Colombo", noBreak, "07:00", "10:00"),
      LeaveScheduleConfigurationError,
    );
  });

  it("rejects a short leave interval overlapping the configured unpaid break", () => {
    const configured = { ...shift, breakStartTime: new Date("1970-01-01T12:30:00.000Z") };
    assert.throws(
      () => getTimeLeaveInterval("2026-10-26", "Asia/Colombo", configured, "12:00", "13:00"),
      LeaveScheduleConfigurationError,
    );
  });
});
