import assert from "node:assert/strict";
import { it } from "node:test";
import { logAttendanceActionError } from "./action-diagnostics";

it("logs only correlated and allowlisted diagnostics, never raw errors, SQL, tokens, or credentials", () => {
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (message?: unknown) => { logged.push(String(message)); };

  const error = Object.assign(
    new Error("SELECT * FROM users WHERE email='employee@example.com' AND password='db-password'"),
    {
      code: "P2004",
      meta: {
        modelName: "WorkFromHomeRequest",
        constraint: "wfh_requests_active_interval_excl",
        query: "SELECT 'query-secret'",
        token: "bearer-secret",
      },
    },
  );
  error.stack = `${error.name}: ${error.message}\n    at connect (postgres://db-user:db-password@database.internal/app)\n    at authorize Bearer signature-secret`;

  try {
    logAttendanceActionError("attendance.submit", error, "/dashboard");
  } finally {
    console.error = originalError;
  }

  const serialized = logged[0] ?? "";
  const record = JSON.parse(serialized) as Record<string, unknown>;
  assert.equal(record.event, "server_action_error");
  assert.equal(record.operation, "attendance.submit");
  assert.equal(record.route, "/dashboard");
  assert.equal(record.prismaCode, "P2004");
  assert.equal(record.prismaModel, "WorkFromHomeRequest");
  assert.equal(record.prismaConstraint, "wfh_requests_active_interval_excl");
  assert.equal(typeof record.requestId, "string");
  for (const sensitiveValue of [
    "SELECT",
    "employee@example.com",
    "password",
    "db-password",
    "db-user",
    "database.internal",
    "query-secret",
    "bearer-secret",
    "signature-secret",
    "connect",
  ]) {
    assert.equal(serialized.includes(sensitiveValue), false, `${sensitiveValue} must not be logged`);
  }
});

it("does not serialize details from non-Error throws", () => {
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (message?: unknown) => { logged.push(String(message)); };
  try {
    logAttendanceActionError("attendance.submit", { password: "private" });
  } finally {
    console.error = originalError;
  }

  const record = JSON.parse(logged[0] ?? "{}") as Record<string, unknown>;
  assert.equal(record.errorName, "UnknownError");
  assert.equal(JSON.stringify(record).includes("private"), false);
});
