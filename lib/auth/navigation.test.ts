import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adminNavigationItems, getDashboardHomePath } from "./admin-navigation";
import { Role } from "@prisma/client";

describe("Super Administrator navigation", () => {
  it("routes Super Administrators to the admin workspace without redirecting other roles", () => {
    assert.equal(getDashboardHomePath(Role.ADMIN), "/admin");
    assert.equal(getDashboardHomePath(Role.EMPLOYEE), "/dashboard");
    assert.equal(getDashboardHomePath(Role.SUPERVISOR), "/dashboard");
    assert.equal(getDashboardHomePath(Role.DEPARTMENT_MANAGER), "/dashboard");
    assert.equal(getDashboardHomePath(Role.HR_ADMINISTRATOR), "/dashboard");
  });

  it("shows organization administration and review links without employee self-service", () => {
    const hrefs: string[] = adminNavigationItems.map(({ href }) => href);

    assert.ok(hrefs.includes("/admin"));
    assert.ok(hrefs.includes("/admin/attendance/daily"));
    assert.ok(hrefs.includes("/approvals/attendance-corrections"));
    assert.ok(hrefs.includes("/admin/reports"));
    assert.ok(hrefs.includes("/settings"));
    assert.ok(!hrefs.includes("/attendance"));
    assert.ok(!hrefs.includes("/attendance/corrections"));
    assert.ok(!hrefs.includes("/leave"));
    assert.ok(!hrefs.includes("/reports"));
    assert.ok(!hrefs.includes("/overtime"));
    assert.ok(!hrefs.includes("/wfh"));
  });
});
