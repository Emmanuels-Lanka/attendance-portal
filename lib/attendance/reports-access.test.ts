import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role } from "@prisma/client";
import { listMonthlySummaryEmployees, MonthlySummaryAccessError } from "./reports";

const employeeRows = [
  { id: "employee-a", name: "A Employee", timeZone: "Asia/Colombo", role: "EMPLOYEE", departmentId: "department-a", employeeId: "A-1" },
  { id: "employee-b", name: "B Employee", timeZone: "Asia/Dhaka", role: "EMPLOYEE", departmentId: "department-b", employeeId: "B-1" },
];

function createDatabase(managerDepartmentId: string | null = "department-a") {
  const calls: Array<{ where: unknown }> = [];
  const database = {
    employee: {
      findUnique: async () => managerDepartmentId ? { departmentId: managerDepartmentId } : null,
      findMany: async ({ where }: { where: { departmentId: string } }) => employeeRows
        .filter((employee) => employee.departmentId === where.departmentId)
        .map((employee) => ({ userId: employee.id })),
    },
    user: {
      findMany: async ({ where }: { where: { role: string; id?: string | { in: string[] } } }) => {
        calls.push({ where });
        return employeeRows
          .filter((employee) => employee.role === where.role)
          .filter((employee) => typeof where.id === "string" ? employee.id === where.id
            : where.id && "in" in where.id ? where.id.in.includes(employee.id) : true)
          .map(({ id, name, timeZone, employeeId, departmentId }) => ({
            id,
            name,
            timeZone,
            employee: { employeeId, department: { name: departmentId } },
          }));
      },
    },
  } as never;
  return { database, calls };
}

describe("monthly summary report access", () => {
  it("allows Admin and HR organization-wide summaries", async () => {
    for (const role of [Role.ADMIN, Role.HR_ADMINISTRATOR]) {
      const stub = createDatabase();
      const employees = await listMonthlySummaryEmployees({ id: "manager", role }, "2026-02", "", stub.database);
      assert.deepEqual(employees.map(({ id }) => id), ["employee-a", "employee-b"]);
      assert.deepEqual(stub.calls[0].where, { role: "EMPLOYEE" });
    }
  });

  it("limits Department Managers to their own department and rejects an out-of-scope selection", async () => {
    const stub = createDatabase("department-a");
    const employees = await listMonthlySummaryEmployees({ id: "manager-a", role: Role.DEPARTMENT_MANAGER }, "2026-02", "", stub.database);
    assert.deepEqual(employees.map(({ id }) => id), ["employee-a"]);

    await assert.rejects(
      listMonthlySummaryEmployees({ id: "manager-a", role: Role.DEPARTMENT_MANAGER }, "2026-02", "employee-b", stub.database),
      MonthlySummaryAccessError,
    );
  });

  it("denies employees and managers without a department, and rejects invalid months", async () => {
    const stub = createDatabase(null);
    await assert.rejects(listMonthlySummaryEmployees({ id: "employee-a", role: Role.EMPLOYEE }, "2026-02", "", stub.database), MonthlySummaryAccessError);
    await assert.rejects(listMonthlySummaryEmployees({ id: "supervisor-a", role: Role.SUPERVISOR }, "2026-02", "", stub.database), MonthlySummaryAccessError);
    assert.deepEqual(await listMonthlySummaryEmployees({ id: "manager", role: Role.DEPARTMENT_MANAGER }, "2026-02", "", stub.database), []);
    await assert.rejects(listMonthlySummaryEmployees({ id: "manager", role: Role.DEPARTMENT_MANAGER }, "2026-13", "", stub.database));
  });
});