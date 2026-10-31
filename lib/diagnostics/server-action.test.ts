import assert from "node:assert/strict";
import { it } from "node:test";
import { appendRefreshWarning, logServerActionError, revalidateAfterCommit } from "./server-action";

it("reports post-commit revalidation failures without converting them into save failures", () => {
  const failure = new Error("cache refresh failed");
  let reported: unknown;
  const refreshed = revalidateAfterCommit(() => {
    throw failure;
  }, (error) => {
    reported = error;
  });

  assert.equal(refreshed, false);
  assert.equal(reported, failure);
  assert.equal(
    appendRefreshWarning("Request saved.", refreshed),
    "Request saved. The change was saved, but the page could not refresh. Reload to see the latest status.",
  );
  assert.equal(appendRefreshWarning("Request saved.", true), "Request saved.");
});

it("logs safe Prisma diagnostics without raw error details", () => {
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (message?: unknown) => { logged.push(String(message)); };
  try {
    logServerActionError(
      "attendance.correction_submit",
      Object.assign(new Error("employee@example.com secret"), {
        code: "P2004",
        meta: { modelName: "WorkFromHomeRequest", constraint: "wfh_requests_active_interval_excl" },
      }),
      "/attendance/corrections",
    );
  } finally {
    console.error = originalError;
  }

  const record = JSON.parse(logged[0] ?? "{}") as Record<string, unknown>;
  assert.equal(record.event, "server_action_error");
  assert.equal(record.operation, "attendance.correction_submit");
  assert.equal(record.route, "/attendance/corrections");
  assert.equal(record.prismaCode, "P2004");
  assert.equal(record.prismaModel, "WorkFromHomeRequest");
  assert.equal(record.prismaConstraint, "wfh_requests_active_interval_excl");
  assert.equal(typeof record.requestId, "string");
  assert.equal(JSON.stringify(record).includes("employee@example.com"), false);
  assert.equal(JSON.stringify(record).includes("secret"), false);
});
