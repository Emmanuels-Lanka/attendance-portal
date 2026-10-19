import assert from "node:assert/strict";
import { describe, it } from "node:test";
import seed from "./seed.cjs";

const {
  ensureExistingAdminUsername,
  isUniqueConstraintError,
  normalizeAdminUsername,
  planAdminSeed,
  planAdminUsernameAssignment,
} = seed;

describe("production-safe administrator seed planning", () => {
  it("normalizes and validates the configured initial administrator username", () => {
    assert.equal(normalizeAdminUsername("  Eliot.Admin-1 "), "eliot.admin-1");
    assert.throws(() => normalizeAdminUsername(undefined), /ADMIN_USERNAME is required/);
    assert.throws(() => normalizeAdminUsername("ab"), /3-30 characters/);
    assert.throws(() => normalizeAdminUsername("admin@company"), /3-30 characters/);
  });

  it("creates only when no configured, legacy, or other administrator exists", () => {
    assert.equal(planAdminSeed(null, null, null), "create");
  });

  it("preserves an existing active admin username and credentials", () => {
    assert.equal(planAdminSeed({ id: "configured", role: "ADMIN", isActive: true, username: "existing.admin" }, null, null), "unchanged");
  });

  it("assigns a username to an existing active admin without one", async () => {
    const admin = { id: "configured", role: "ADMIN", isActive: true, username: null };
    assert.equal(planAdminSeed(admin, null, null), "assign-username");
    assert.equal(planAdminUsernameAssignment(admin, null), "assign");

    const updates = [];
    const database = {
      user: {
        findFirst: async () => null,
        update: async ({ where, data }) => {
          updates.push({ where, data });
          admin.username = data.username;
        },
      },
    };
    assert.equal(await ensureExistingAdminUsername(database, admin, "configured.admin"), true);
    assert.deepEqual(updates, [{ where: { id: "configured" }, data: { username: "configured.admin" } }]);
  });

  it("preserves an existing username and does not update account credentials", async () => {
    const admin = { id: "configured", role: "ADMIN", isActive: true, username: "existing.admin" };
    let lookups = 0;
    let updates = 0;
    const database = {
      user: {
        findFirst: async () => { lookups += 1; return { id: "other-account" }; },
        update: async () => { updates += 1; },
      },
    };

    assert.equal(await ensureExistingAdminUsername(database, admin, "replacement.admin"), false);
    assert.equal(admin.username, "existing.admin");
    assert.equal(lookups, 1);
    assert.equal(updates, 0);
  });

  it("fails safely when the configured username belongs to another account", async () => {
    const admin = { id: "configured", role: "ADMIN", isActive: true, username: null };
    const database = {
      user: {
        findFirst: async () => ({ id: "other-account" }),
        update: async () => assert.fail("Should not update a username owned by another account."),
      },
    };
    assert.throws(
      () => planAdminUsernameAssignment(admin, { id: "other-account" }),
      /ADMIN_USERNAME is already assigned to another account/,
    );
    await assert.rejects(
      ensureExistingAdminUsername(database, admin, "configured.admin"),
      /ADMIN_USERNAME is already assigned to another account/,
    );
  });

  it("is idempotent across repeated username-assignment executions", async () => {
    const admin = { id: "configured", role: "ADMIN", isActive: true, username: null };
    let updates = 0;
    const database = {
      user: {
        findFirst: async () => admin.username ? { id: admin.id } : null,
        update: async ({ data }) => {
          updates += 1;
          admin.username = data.username;
        },
      },
    };

    assert.equal(await ensureExistingAdminUsername(database, admin, "configured.admin"), true);
    assert.equal(planAdminSeed(admin, null, null), "unchanged");
    assert.equal(await ensureExistingAdminUsername(database, admin, "configured.admin"), false);
    assert.equal(admin.username, "configured.admin");
    assert.equal(updates, 1);
  });

  it("recognizes concurrent username assignment and handles unique-index races", () => {
    const admin = { id: "configured", role: "ADMIN", isActive: true, username: null };
    assert.equal(planAdminUsernameAssignment(admin, { id: admin.id }), "unchanged");
    assert.equal(isUniqueConstraintError({ code: "P2002" }), true);
    assert.equal(isUniqueConstraintError({ code: "P2025" }), false);
  });

  it("refuses to overwrite an inactive or non-admin account at the configured email", () => {
    assert.throws(() => planAdminSeed({ role: "ADMIN", isActive: false }, null, null), /No changes were made/);
    assert.throws(() => planAdminSeed({ role: "EMPLOYEE", isActive: true }, null, null), /No changes were made/);
  });

  it("refuses to rename a legacy account or create another admin implicitly", () => {
    assert.throws(() => planAdminSeed(null, { id: "legacy" }, null), /Resolve it manually/);
    assert.throws(() => planAdminSeed(null, null, { id: "existing-admin" }), /will not create another/);
  });

  it("refuses to leave two active configured and legacy administrators in place", () => {
    assert.throws(
      () => planAdminSeed({ role: "ADMIN", isActive: true }, { role: "ADMIN", isActive: true }, null),
      /active legacy administrator/,
    );
  });
});