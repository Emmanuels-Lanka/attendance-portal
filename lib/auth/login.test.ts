import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashPassword } from "@/lib/auth/password";
import { authenticateLogin, loginIdentifierSchema } from "@/lib/auth/login";

const password = "Login-Test-Password-2026";
const account = {
  id: "user-1",
  passwordHash: "",
  isActive: true,
  username: null as string | null,
};

function createDatabase(matches: typeof account[]) {
  let query: Record<string, unknown> | undefined;
  const database = {
    user: {
      findMany: async (input: Record<string, unknown>) => {
        query = input;
        return matches;
      },
    },
  } as never;
  return { database, getQuery: () => query };
}

describe("email and username login", () => {
  it("normalizes a valid email identifier and preserves email login", async () => {
    const databaseStub = createDatabase([{ ...account, passwordHash: await hashPassword(password) }]);
    let sessions = 0;
    const parsed = loginIdentifierSchema.parse("  EMPLOYEE@Example.com ");

    assert.equal(parsed, "employee@example.com");
    assert.equal(await authenticateLogin(parsed, password, async () => { sessions += 1; }, databaseStub.database), true);
    assert.equal(sessions, 1);
    assert.deepEqual(databaseStub.getQuery(), {
      where: { OR: [{ email: "employee@example.com" }, { username: "employee@example.com" }] },
      select: { id: true, passwordHash: true, isActive: true },
    });
  });

  it("normalizes username case for lookup and creates a session on success", async () => {
    const databaseStub = createDatabase([{ ...account, passwordHash: await hashPassword(password) }]);
    let sessionUserId: string | undefined;
    const parsed = loginIdentifierSchema.parse("Ravi.Employee");

    assert.equal(parsed, "ravi.employee");
    assert.equal(await authenticateLogin(parsed, password, async (userId) => { sessionUserId = userId; }, databaseStub.database), true);
    assert.equal(sessionUserId, "user-1");
    assert.deepEqual(databaseStub.getQuery()?.where, {
      OR: [{ email: "ravi.employee" }, { username: "ravi.employee" }],
    });
  });

  it("rejects invalid usernames and enforces the agreed length and character rules", () => {
    for (const identifier of ["ab", "a".repeat(31), "bad name", "bad@name", "bad/name", ""]) {
      assert.equal(loginIdentifierSchema.safeParse(identifier).success, false, identifier);
    }
    assert.equal(loginIdentifierSchema.safeParse("abc").success, true);
    assert.equal(loginIdentifierSchema.safeParse("a".repeat(30)).success, true);
    assert.equal(loginIdentifierSchema.safeParse("employee@example.com").success, true);
  });

  it("does not create a session for an incorrect password or unknown identifier", async () => {
    const matchingAccount = createDatabase([{ ...account, passwordHash: await hashPassword(password) }]);
    const unknownAccount = createDatabase([]);
    let sessions = 0;
    const createSession = async () => { sessions += 1; };

    assert.equal(await authenticateLogin("employee@example.com", "Incorrect-Password-2026", createSession, matchingAccount.database), false);
    assert.equal(await authenticateLogin("missing@example.com", password, createSession, unknownAccount.database), false);
    assert.equal(sessions, 0);
  });

  it("keeps accounts without usernames available through email login", async () => {
    const legacyAccount = createDatabase([{ ...account, passwordHash: await hashPassword(password) }]);

    assert.equal(await authenticateLogin("legacy@example.com", password, async () => {}, legacyAccount.database), true);
  });

  it("rejects inactive accounts and ambiguous email/username matches without creating sessions", async () => {
    const passwordHash = await hashPassword(password);
    const inactiveAccount = createDatabase([{ ...account, isActive: false, passwordHash }]);
    const ambiguousAccounts = createDatabase([
      { ...account, id: "email-owner", passwordHash },
      { ...account, id: "username-owner", passwordHash },
    ]);
    let sessions = 0;
    const createSession = async () => { sessions += 1; };

    assert.equal(await authenticateLogin("inactive@example.com", password, createSession, inactiveAccount.database), false);
    assert.equal(await authenticateLogin("collision@example.com", password, createSession, ambiguousAccounts.database), false);
    assert.equal(sessions, 0);
  });
});
