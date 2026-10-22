import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAttendanceEmployees } from "./employee-link";

function createDatabase(employees: Array<{
  id: string;
  name: string;
  employeeId: string | null;
  userId: string | null;
}>) {
  let receivedUserIds: string[] = [];
  const database = {
    employee: {
      findMany: async ({ where }: { where: { userId: { in: string[] } } }) => {
        receivedUserIds = where.userId.in;
        return employees.filter((employee) => employee.userId !== null && where.userId.in.includes(employee.userId));
      },
    },
  } as never;
  return { database, getReceivedUserIds: () => receivedUserIds };
}

describe("attendance Employee compatibility lookup", () => {
  it("resolves a User to the linked Employee without changing the User identifier", async () => {
    const stub = createDatabase([
      { id: "employee-1", name: "Alex Employee", employeeId: "E-1", userId: "user-1" },
    ]);

    const result = await resolveAttendanceEmployees(["user-1", "user-1"], stub.database);

    assert.deepEqual([...result.entries()], [[
      "user-1",
      { id: "employee-1", name: "Alex Employee", employeeId: "E-1", shiftAssignments: [] },
    ]]);
    assert.deepEqual(stub.getReceivedUserIds(), ["user-1"]);
  });

  it("returns no Employee identity for a User without a linked Employee", async () => {
    const stub = createDatabase([
      { id: "employee-unlinked", name: "Unlinked", employeeId: null, userId: null },
    ]);

    const result = await resolveAttendanceEmployees(["user-without-employee"], stub.database);

    assert.equal(result.has("user-without-employee"), false);
    assert.deepEqual(stub.getReceivedUserIds(), ["user-without-employee"]);
  });

  it("does not treat an Employee with a null userId as attendance-eligible", async () => {
    const database = {
      employee: {
        findMany: async () => [
          { id: "employee-unlinked", name: "Unlinked", employeeId: "E-2", userId: null },
        ],
      },
    } as never;
    const result = await resolveAttendanceEmployees(["user-1"], database);

    assert.equal(result.size, 0);
  });

  it("returns an empty mapping without querying when there are no attendance Users", async () => {
    const stub = createDatabase([]);

    const result = await resolveAttendanceEmployees([], stub.database);

    assert.equal(result.size, 0);
    assert.deepEqual(stub.getReceivedUserIds(), []);
  });
});
