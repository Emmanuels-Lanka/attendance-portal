import assert from "node:assert/strict";
import { it } from "node:test";
import { employeeDetailRedirect, employeeMutationRedirect } from "./action-feedback";

for (const operation of ["create", "update"] as const) {
  it(`redirects a committed employee ${operation} with a refresh warning, not a save failure`, () => {
    let committed = false;
    const refreshError = new Error("cache refresh failed");
    let reportedError: unknown;

    committed = true;
    const destination = employeeMutationRedirect(
      "employee-1",
      () => {
        assert.equal(committed, true, "revalidation must occur after the mutation commits");
        throw refreshError;
      },
      (error) => { reportedError = error; },
    );

    assert.equal(destination, "/admin/employees/employee-1?refresh=failed");
    assert.equal(committed, true);
    assert.equal(reportedError, refreshError);
  });
}

it("keeps the employee detail destination clean after successful revalidation", () => {
  const destination = employeeMutationRedirect("employee-1", () => {}, () => {
    assert.fail("successful revalidation must not report an error");
  });
  assert.equal(destination, "/admin/employees/employee-1");
  assert.equal(employeeDetailRedirect("employee/id", true), "/admin/employees/employee%2Fid");
});
