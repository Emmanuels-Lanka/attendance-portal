import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDailyReconciliationHandler } from "./daily-reconciliation-http";

const secret = "local-test-reconciliation-secret";
const summary = {
  claimed: 1,
  pending: 0,
  calculated: 1,
  protected: 0,
  skippedInactive: 0,
  unlinkedEmployees: 0,
  superseded: 0,
  retried: 0,
  deadLettered: 0,
  failureCategories: {},
};

describe("daily reconciliation HTTP trigger", () => {
  it("rejects missing or invalid credentials and rejects query parameters", async () => {
    let calls = 0;
    const handler = createDailyReconciliationHandler(async () => {
      calls += 1;
      return summary;
    }, () => secret);

    assert.equal((await handler(new Request("http://localhost/api/attendance/reconcile-daily"))).status, 401);
    assert.equal((await handler(new Request("http://localhost/api/attendance/reconcile-daily", {
      headers: { authorization: "Bearer incorrect" },
    }))).status, 401);
    assert.equal((await handler(new Request("http://localhost/api/attendance/reconcile-daily?employeeId=someone", {
      headers: { authorization: `Bearer ${secret}` },
    }))).status, 400);
    assert.equal(calls, 0);
  });

  it("requires configuration and returns the bounded worker summary", async () => {
    const unconfigured = createDailyReconciliationHandler(async () => summary, () => undefined);
    assert.equal((await unconfigured(new Request("http://localhost/api/attendance/reconcile-daily"))).status, 503);

    const handler = createDailyReconciliationHandler(async () => summary, () => secret);
    const response = await handler(new Request("http://localhost/api/attendance/reconcile-daily", {
      headers: { authorization: `Bearer ${secret}` },
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, summary });
  });

  it("surfaces retry and dead-letter outcomes as an operational failure", async () => {
    const handler = createDailyReconciliationHandler(async () => ({
      ...summary,
      retried: 1,
      failureCategories: { AttendanceEngineConfigurationError: 1 },
    }), () => secret);
    const response = await handler(new Request("http://localhost/api/attendance/reconcile-daily", {
      headers: { authorization: `Bearer ${secret}` },
    }));

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      ok: false,
      summary: {
        ...summary,
        retried: 1,
        failureCategories: { AttendanceEngineConfigurationError: 1 },
      },
    });
  });
});
