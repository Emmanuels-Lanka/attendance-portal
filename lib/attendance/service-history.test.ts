import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getEmployeeAttendanceDashboard, getEmployeeAttendanceHistory } from "./service";

const weekdayShift = {
  id: "weekday-shift",
  startTime: new Date("1970-01-01T08:00:00.000Z"),
  endTime: new Date("1970-01-01T17:30:00.000Z"),
  gracePeriodMinutes: 10,
  workingDays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
};

function createReadDatabase(startAt: Date, endAt: Date | null) {
  const sessions = [{ id: "session-1", mode: "WFH" as const, startAt, endAt }];
  const employeeLookups: Array<{ userId: string }> = [];
  const employee = {
    shift: null,
    shiftAssignments: [{
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      effectiveTo: null,
      shift: weekdayShift,
    }],
  };
  const database = {
    workSession: {
      findFirst: async () => sessions[0],
      findMany: async () => sessions,
    },
    employee: {
      findUnique: async ({ where }: { where: { userId: string } }) => {
        employeeLookups.push(where);
        return employee;
      },
    },
  };
  return { database: database as never, employeeLookups };
}

describe("employee attendance history shift data flow", () => {
  it("loads effective assignments and classifies historical WFH sessions by their local date", async () => {
    const stub = createReadDatabase(
      new Date("2026-06-15T02:40:01.000Z"),
      new Date("2026-06-15T12:30:00.000Z"),
    );
    const history = await getEmployeeAttendanceHistory({ id: "user-1", timeZone: "Asia/Colombo" }, stub.database);
    assert.equal(history.days[0].sessions[0].timing?.arrival, "LATE");
    assert.deepEqual(stub.employeeLookups, [{ userId: "user-1" }]);
  });

  it("returns shift-aware timing for an active personal dashboard session", async () => {
    const now = new Date("2026-06-15T03:00:00.000Z");
    const stub = createReadDatabase(new Date("2026-06-15T02:40:00.000Z"), null);
    const dashboard = await getEmployeeAttendanceDashboard(
      { id: "user-1", timeZone: "Asia/Colombo" },
      now,
      stub.database,
    );
    assert.equal(dashboard.activeSessionTiming?.arrival, "ON_TIME");
    assert.equal(dashboard.day.sessions[0].timing?.arrival, "ON_TIME");
  });
});
