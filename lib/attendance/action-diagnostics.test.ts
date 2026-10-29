import assert from "node:assert/strict";
import { it } from "node:test";
import { attendanceActionErrorDetails } from "./action-diagnostics";

it("keeps safe Prisma diagnostics while redacting credentials and personal data", () => {
  const error = Object.assign(
    new Error(
      "Failed for employee@example.com: postgresql://db-user:db-password@db.example.test/attendance?password=query-secret "
      + "Bearer bearer-secret eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature-secret sessionSecret=session-secret",
    ),
    { code: "P1001", clientVersion: "6.19.3" },
  );

  const details = attendanceActionErrorDetails(error);
  const serialized = JSON.stringify(details);

  assert.equal(details.name, "Error");
  assert.equal(details.code, "P1001");
  assert.match(details.message, /\[REDACTED_DATABASE_URL\]/);
  assert.match(details.message, /\[REDACTED_EMAIL\]/);
  assert.match(details.message, /\[REDACTED_TOKEN\]/);
  assert.match(details.message, /Bearer \[REDACTED\]/);
  for (const secret of [
    "employee@example.com",
    "db-user",
    "db-password",
    "query-secret",
    "bearer-secret",
    "signature-secret",
    "session-secret",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.ok(details.stack);
  assert.equal(details.stack.includes("Failed for employee"), false);
});

it("does not serialize details from non-Error throws", () => {
  assert.deepEqual(attendanceActionErrorDetails({ password: "private" }), {
    name: "UnknownError",
    message: "A non-Error value was thrown.",
  });
});
