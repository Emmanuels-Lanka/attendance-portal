import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role } from "@prisma/client";
import { verifyPassword } from "@/lib/auth/password";
import { accountIsActive } from "@/lib/auth/account-status";
import {
  createEmployee,
  EmployeeAccessError,
  EmployeeAdministratorAccountError,
  EmployeeDuplicateError,
  EmployeeNotFoundError,
  EmployeeReportingAssignmentError,
  changedEmployeeFieldNames,
  employeeAuditMetadata,
  getEmployee,
  listEmployees,
  listEmployeeReportingOptions,
  publicEmployeeSelect,
  setEmployeeActive,
  updateEmployee,
  writeEmployeeAuditEvent,
} from "@/lib/employees/service";
import { adminEmployeeProfilePatchSchema, createEmployeeSchema, updateEmployeeSchema } from "@/lib/employees/validation";
import { OrganizationNotFoundError } from "@/lib/organization/service";
import { ShiftAssignmentConflictError, ShiftNotFoundError } from "@/lib/shifts/service";

const admin = { role: Role.ADMIN };
const hrAdmin = { role: Role.HR_ADMINISTRATOR };
const employeeInput = {
  name: "Ravi Employee",
  employeeCode: "EMP-1001",
  email: "ravi@example.com",
  username: "ravi.employee",
  password: "Employee-Test-Password-2026",
  role: Role.EMPLOYEE,
  countryCode: "LK",
  timeZone: "Asia/Colombo",
};

function createDatabaseStub() {
  let storedEmployee: Record<string, unknown> | undefined;
  let createData: Record<string, unknown> | undefined;
  let createSelect: Record<string, unknown> | undefined;
  let updateData: Record<string, unknown> | undefined;
  let currentShiftId: string | null = null;
  let currentShiftAssignments: Array<{ shiftId: string; effectiveFrom: Date; effectiveTo: null }> = [];
  const user = {
    findUnique: async ({ where }: { where: { id: string } }) => storedEmployee?.id === where.id
      ? { role: storedEmployee.role }
      : null,
    create: async ({ data, select }: { data: Record<string, unknown>; select: Record<string, unknown> }) => {
      createData = data;
      createSelect = select;
      const employeeCreate = (data.employee as { create: Record<string, unknown> }).create;
      currentShiftId = employeeCreate.shiftId as string | null;
      currentShiftAssignments = ((employeeCreate.shiftAssignments as { create: Array<{ shiftId: string; effectiveFrom: Date }> } | undefined)?.create ?? [])
        .map((assignment) => ({ ...assignment, effectiveTo: null }));
      storedEmployee = { ...data, id: "employee-1", createdAt: new Date(), updatedAt: new Date(), isActive: true };
      return Object.fromEntries(Object.keys(select).map((key) => [key, storedEmployee?.[key]]));
    },
    update: async ({ data, select }: { data: Record<string, unknown>; select: Record<string, unknown> }) => {
      updateData = data;
      const employeeUpsert = data.employee as { upsert?: { update?: Record<string, unknown> } } | undefined;
      const employeeUpdate = employeeUpsert?.upsert?.update;
      if (employeeUpdate && "shiftId" in employeeUpdate) currentShiftId = employeeUpdate.shiftId as string | null;
      storedEmployee = { ...storedEmployee, ...data, updatedAt: new Date() };
      return Object.fromEntries(Object.keys(select).map((key) => [key, storedEmployee?.[key]]));
    },
  };
  const department = {
    findUnique: async ({ where }: { where: { id: string } }) => where.id === "department-1" ? { id: where.id } : null,
  };
  const designation = {
    findUnique: async ({ where }: { where: { id: string } }) => where.id === "designation-1" ? { id: where.id } : null,
  };
  const shift = {
    findUnique: async ({ where }: { where: { id: string } }) => ["shift-1", "weekday", "saturday", "overlap"].includes(where.id) ? { id: where.id } : null,
    findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
      const workingDaysById: Record<string, string[]> = {
        "shift-1": ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
        weekday: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
        saturday: ["SATURDAY"],
        overlap: ["MONDAY"],
      };
      return where.id.in.flatMap((id) => workingDaysById[id] ? [{ id, workingDays: workingDaysById[id] }] : []);
    },
  };
  const employee = {
    findUnique: async () => storedEmployee
      ? { shiftId: currentShiftId, shiftAssignments: currentShiftAssignments }
      : null,
  };

  return {
    database: { user, employee, department, designation, shift } as never,
    getCreateData: () => createData,
    getCreateSelect: () => createSelect,
    getUpdateData: () => updateData,
  };
}

function createReportingDatabaseStub(current?: { id: string; departmentId: string | null }) {
  const selectedEmployees = new Map([
    ["supervisor-1", { id: "supervisor-1", user: { role: Role.SUPERVISOR, isActive: true } }],
    ["manager-1", { id: "manager-1", departmentId: "department-1", user: { role: Role.DEPARTMENT_MANAGER, isActive: true } }],
  ]);
  let createData: Record<string, unknown> | undefined;
  let updateData: Record<string, unknown> | undefined;
  const database = {
    user: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createData = data;
        return { ...data, id: "new-user", isActive: true };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updateData = data;
        return { id: "current-user" };
      },
    },
    employee: {
      findUnique: async ({ where }: { where: { id?: string; userId?: string } }) => {
        if (where.userId) return current ?? null;
        if (current && where.id === current.id) return { id: current.id, user: { role: Role.SUPERVISOR, isActive: true } };
        return selectedEmployees.get(where.id ?? "") ?? null;
      },
    },
    department: { findUnique: async ({ where }: { where: { id: string } }) => ["department-1", "department-other"].includes(where.id) ? { id: where.id } : null },
    designation: { findUnique: async () => null },
    shift: { findUnique: async () => null },
  } as never;
  return { database, getCreateData: () => createData, getUpdateData: () => updateData };
}

describe("employee management", () => {
  it("allows an admin to create a hashed employee account without returning its hash", async () => {
    const stub = createDatabaseStub();
    const created = await createEmployee(admin, employeeInput, stub.database);

    assert.equal(created.email, "ravi@example.com");
    assert.equal(created.isActive, true);
    assert.equal(stub.getCreateData()?.username, "ravi.employee");
    assert.equal("passwordHash" in created, false);
    assert.equal("passwordHash" in (stub.getCreateSelect() ?? {}), false);
    assert.notEqual(stub.getCreateData()?.passwordHash, employeeInput.password);
    assert.equal(await verifyPassword(employeeInput.password, String(stub.getCreateData()?.passwordHash)), true);
    assert.deepEqual(stub.getCreateData()?.employee, {
      create: {
        name: employeeInput.name,
        employeeId: employeeInput.employeeCode,
        departmentId: null,
        designationId: null,
        shiftId: null,
        supervisorId: null,
        managerId: null,
        profileOnboardingRequired: true,
      },
    });
    assert.equal("nic" in (stub.getCreateData() ?? {}), false);
    assert.equal("epfId" in (stub.getCreateData() ?? {}), false);
    assert.equal("etfId" in (stub.getCreateData() ?? {}), false);
  });

  it("rejects a non-admin before attempting to create an employee", async () => {
    const stub = createDatabaseStub();
    await assert.rejects(createEmployee({ role: Role.EMPLOYEE }, employeeInput, stub.database), EmployeeAccessError);
    assert.equal(stub.getCreateData(), undefined);
  });

  it("rejects non-admin employee/profile updates before attempting a database write", async () => {
    const stub = createDatabaseStub();

    await assert.rejects(updateEmployee({ role: Role.EMPLOYEE }, "employee-1", {
      ...employeeInput,
      password: "",
      profile: { email: "contact@example.com" },
    }, stub.database), EmployeeAccessError);
    assert.equal(stub.getUpdateData(), undefined);
  });

  it("allows HR Administrators to create and update employee accounts", async () => {
    const stub = createDatabaseStub();
    await createEmployee(hrAdmin, employeeInput, stub.database);
    assert.equal(stub.getCreateData()?.role, Role.EMPLOYEE);

    await updateEmployee(hrAdmin, "employee-1", { ...employeeInput, name: "HR Updated Employee", password: "" }, stub.database);
    assert.equal(stub.getUpdateData()?.name, "HR Updated Employee");
  });

  it("does not allow HR Administrators to create or modify administrator accounts", async () => {
    const stub = createDatabaseStub();
    await assert.rejects(
      createEmployee(hrAdmin, { ...employeeInput, role: Role.ADMIN }, stub.database),
      EmployeeAdministratorAccountError,
    );
    await assert.rejects(
      createEmployee(hrAdmin, { ...employeeInput, role: Role.HR_ADMINISTRATOR }, stub.database),
      EmployeeAdministratorAccountError,
    );
    assert.equal(stub.getCreateData(), undefined);

    const administratorDatabase = {
      user: {
        findUnique: async () => ({ role: Role.ADMIN }),
        update: async () => assert.fail("HR must not update a Super Administrator account"),
      },
      employee: {},
      department: {},
      designation: {},
      shift: {},
    } as never;
    await assert.rejects(
      updateEmployee(hrAdmin, "super-admin", { ...employeeInput, password: "" }, administratorDatabase),
      EmployeeAdministratorAccountError,
    );
    await assert.rejects(
      setEmployeeActive(hrAdmin, "super-admin", false, administratorDatabase),
      EmployeeAdministratorAccountError,
    );
  });

  it("rejects an invalid IANA timezone", () => {
    const result = createEmployeeSchema.safeParse({ ...employeeInput, timeZone: "Mars/Olympus" });
    assert.equal(result.success, false);
  });

  it("accepts the SRS HR, Department Manager, and Supervisor roles", () => {
    for (const role of [Role.HR_ADMINISTRATOR, Role.DEPARTMENT_MANAGER, Role.SUPERVISOR]) {
      assert.equal(createEmployeeSchema.safeParse({ ...employeeInput, role }).success, true);
    }
  });

  it("normalizes usernames and enforces the agreed format and length", () => {
    const normalized = createEmployeeSchema.safeParse({ ...employeeInput, username: "Ravi.Employee-1" });
    const lowercase = createEmployeeSchema.safeParse({ ...employeeInput, username: "ravi.employee-1" });
    assert.equal(normalized.success, true);
    assert.equal(lowercase.success, true);
    if (normalized.success && lowercase.success) {
      assert.equal(normalized.data.username, "ravi.employee-1");
      assert.equal(normalized.data.username, lowercase.data.username);
    }

    for (const username of ["ab", "a".repeat(31), "bad name", "bad@name", "bad/name", ""]) {
      assert.equal(createEmployeeSchema.safeParse({ ...employeeInput, username }).success, false, username);
    }
    assert.equal(createEmployeeSchema.safeParse({ ...employeeInput, username: "abc" }).success, true);
    assert.equal(createEmployeeSchema.safeParse({ ...employeeInput, username: "a".repeat(30) }).success, true);
  });

  it("requires usernames for new accounts but permits legacy accounts to remain username-less", () => {
    assert.equal(createEmployeeSchema.safeParse({ ...employeeInput, username: undefined }).success, false);
    const updated = updateEmployeeSchema.safeParse({ ...employeeInput, password: "", username: "" });
    assert.equal(updated.success, true);
    if (updated.success) assert.equal(updated.data.username, null);
  });

  it("requires profile onboarding for every non-administrator role", async () => {
    const stub = createDatabaseStub();
    await createEmployee(admin, { ...employeeInput, role: Role.SUPERVISOR }, stub.database);
    const employee = (stub.getCreateData()?.employee as { create: Record<string, unknown> }).create;
    assert.equal(employee.profileOnboardingRequired, true);
  });

  it("rejects a missing country code", () => {
    const missingCountry = Object.fromEntries(Object.entries(employeeInput).filter(([key]) => key !== "countryCode"));
    const result = createEmployeeSchema.safeParse(missingCountry);
    assert.equal(result.success, false);
  });

  it("translates duplicate email and employee code constraints", async () => {
    for (const target of ["email", "username", "employeeCode", "employeeId", "nic"]) {
      const database = {
        user: {
          create: async () => {
            throw { code: "P2002", meta: { target: [target] } };
          },
        },
      } as never;
      await assert.rejects(createEmployee(admin, employeeInput, database), (error: unknown) => {
        assert.ok(error instanceof EmployeeDuplicateError);
        assert.equal(error.field, target);
        return true;
      });
    }
  });

  it("deactivates employees and makes them ineligible for authentication", async () => {
    const stub = createDatabaseStub();
    await createEmployee(admin, employeeInput, stub.database);
    const updated = await setEmployeeActive(admin, "employee-1", false, stub.database);

    assert.equal(updated.isActive, false);
    assert.equal(accountIsActive(updated), false);
    assert.equal("passwordHash" in updated, false);
  });

  it("keeps Employee name and ID synchronized with the legacy User fields on update", async () => {
    const stub = createDatabaseStub();
    await createEmployee(admin, employeeInput, stub.database);

    await updateEmployee(admin, "employee-1", { ...employeeInput, name: "Updated Employee", employeeCode: "EMP-1002", password: "" }, stub.database);

    assert.equal(stub.getUpdateData()?.username, employeeInput.username);
    assert.deepEqual(stub.getUpdateData()?.employee, {
      upsert: {
        create: { name: "Updated Employee", employeeId: "EMP-1002", departmentId: null, designationId: null, shiftId: null, supervisorId: null, managerId: null, profileOnboardingRequired: false },
        update: { name: "Updated Employee", employeeId: "EMP-1002" },
      },
    });
  });

  it("persists NIC and optional EPF/ETF values separately on Employee", async () => {
    const stub = createDatabaseStub();
    await createEmployee(admin, { ...employeeInput, nic: "NIC-123", epfId: "", etfId: "ETF-456" }, stub.database);

    assert.deepEqual(stub.getCreateData()?.employee, {
      create: {
        name: employeeInput.name,
        employeeId: employeeInput.employeeCode,
        nic: "NIC-123",
        epfId: null,
        etfId: "ETF-456",
        departmentId: null,
        designationId: null,
        shiftId: null,
        supervisorId: null,
        managerId: null,
        profileOnboardingRequired: true,
      },
    });
  });

  it("updates only submitted EmployeeProfile fields and does not mass-assign client IDs", async () => {
    const stub = createDatabaseStub();
    await createEmployee(admin, employeeInput, stub.database);

    await updateEmployee(admin, "employee-1", {
      ...employeeInput,
      password: "",
      profile: { email: "contact@example.com", employeeRecordId: "other-employee", userId: "other-user" },
    }, stub.database);

    const employeeUpdate = (stub.getUpdateData()?.employee as { upsert: { update: Record<string, unknown> } }).upsert.update;
    assert.deepEqual(employeeUpdate.profile, {
      upsert: {
        create: { email: "contact@example.com" },
        update: { email: "contact@example.com" },
      },
    });
    assert.equal("employeeRecordId" in employeeUpdate, false);
    assert.equal("userId" in employeeUpdate, false);
    assert.equal(stub.getUpdateData()?.email, employeeInput.email);
  });

  it("accepts and round-trips all supported admin gender profile values", async () => {
    for (const gender of ["MALE", "FEMALE", "PREFER_NOT_TO_SAY", "CUSTOM"] as const) {
      const parsed = adminEmployeeProfilePatchSchema.parse({
        gender,
        genderCustom: gender === "CUSTOM" ? "  Non-binary  " : "",
      });
      assert.equal(parsed.gender, gender);
      assert.equal(parsed.genderCustom, gender === "CUSTOM" ? "Non-binary" : null);

      const stub = createDatabaseStub();
      await createEmployee(admin, employeeInput, stub.database);
      await updateEmployee(admin, "employee-1", {
        ...employeeInput,
        password: "",
        profile: parsed,
      }, stub.database);
      const employeeUpdate = (stub.getUpdateData()?.employee as { upsert: { update: Record<string, unknown> } }).upsert.update;
      assert.deepEqual(employeeUpdate.profile, {
        upsert: {
          create: { gender, genderCustom: gender === "CUSTOM" ? "Non-binary" : null },
          update: { gender, genderCustom: gender === "CUSTOM" ? "Non-binary" : null },
        },
      });
    }
    assert.deepEqual(adminEmployeeProfilePatchSchema.parse({ gender: "", genderCustom: "" }), {
      gender: null,
      genderCustom: null,
    });
    assert.deepEqual(adminEmployeeProfilePatchSchema.parse({}), {});
    assert.deepEqual(adminEmployeeProfilePatchSchema.parse({ gender: null }), { gender: null });
    assert.deepEqual(adminEmployeeProfilePatchSchema.parse({ motherName: "Legacy partial parent" }), {
      motherName: "Legacy partial parent",
    });
    assert.deepEqual(adminEmployeeProfilePatchSchema.parse({ fatherContactNumber: "+94770000000" }), {
      fatherContactNumber: "+94770000000",
    });
    assert.equal(adminEmployeeProfilePatchSchema.safeParse({ gender: "UNKNOWN" }).success, false);
    assert.equal(adminEmployeeProfilePatchSchema.safeParse({ gender: "CUSTOM", genderCustom: "" }).success, false);

    const stub = createDatabaseStub();
    await createEmployee(admin, employeeInput, stub.database);
    await updateEmployee(admin, "employee-1", {
      ...employeeInput,
      password: "",
      profile: { gender: "CUSTOM", genderCustom: "Non-binary" },
    }, stub.database);
    const employeeUpdate = (stub.getUpdateData()?.employee as { upsert: { update: Record<string, unknown> } }).upsert.update;
    assert.deepEqual(employeeUpdate.profile, {
      upsert: {
        create: { gender: "CUSTOM", genderCustom: "Non-binary" },
        update: { gender: "CUSTOM", genderCustom: "Non-binary" },
      },
    });

    await updateEmployee(admin, "employee-1", {
      ...employeeInput,
      password: "",
      profile: { gender: "MALE" },
    }, stub.database);
    const standardGenderUpdate = (stub.getUpdateData()?.employee as { upsert: { update: Record<string, unknown> } }).upsert.update;
    assert.deepEqual(standardGenderUpdate.profile, {
      upsert: {
        create: { gender: "MALE", genderCustom: null },
        update: { gender: "MALE", genderCustom: null },
      },
    });
  });

  it("does not reopen onboarding when an administrator clears optional spouse fields", async () => {
    const stub = createDatabaseStub();
    await createEmployee(admin, employeeInput, stub.database);
    await updateEmployee(admin, "employee-1", {
      ...employeeInput,
      password: "",
      profile: { spouseName: "", spouseId: "" },
    }, stub.database);

    const employeeUpdate = (stub.getUpdateData()?.employee as { upsert: { update: Record<string, unknown> } }).upsert.update;
    assert.equal("profileOnboardingRequired" in employeeUpdate, false);
    assert.equal("profileCompletedAt" in employeeUpdate, false);
    assert.deepEqual(employeeUpdate.profile, {
      upsert: {
        create: { spouseName: null, spouseId: null },
        update: { spouseName: null, spouseId: null },
      },
    });
  });

  it("reopens profile completion when an admin clears a mandatory profile field", async () => {
    const stub = createDatabaseStub();
    await createEmployee(admin, employeeInput, stub.database);

    await updateEmployee(admin, "employee-1", {
      ...employeeInput,
      password: "",
      profile: { permanentAddress: "" },
    }, stub.database);

    const employeeUpdate = (stub.getUpdateData()?.employee as { upsert: { update: Record<string, unknown> } }).upsert.update;
    assert.equal(employeeUpdate.profileOnboardingRequired, true);
    assert.equal(employeeUpdate.profileCompletedAt, null);
    assert.deepEqual(employeeUpdate.profile, {
      upsert: {
        create: { permanentAddress: null },
        update: { permanentAddress: null },
      },
    });
  });

  it("creates and updates optional Department and Designation assignments independently", async () => {
    const stub = createDatabaseStub();
    await createEmployee(admin, { ...employeeInput, departmentId: "department-1", designationId: "designation-1" }, stub.database);
    assert.deepEqual((stub.getCreateData()?.employee as { create: Record<string, unknown> }).create, {
      name: employeeInput.name,
      employeeId: employeeInput.employeeCode,
      departmentId: "department-1",
      designationId: "designation-1",
      shiftId: null,
      supervisorId: null,
      managerId: null,
      profileOnboardingRequired: true,
    });

    await updateEmployee(admin, "employee-1", {
      ...employeeInput,
      password: "",
      departmentId: null,
      designationId: "designation-1",
    }, stub.database);
    const employeeUpdate = (stub.getUpdateData()?.employee as { upsert: { update: Record<string, unknown> } }).upsert.update;
    assert.equal(employeeUpdate.departmentId, null);
    assert.equal(employeeUpdate.designationId, "designation-1");
  });

  it("rejects nonexistent Department and Designation assignment IDs before writing", async () => {
    const stub = createDatabaseStub();
    for (const assignments of [{ departmentId: "missing" }, { designationId: "missing" }]) {
      await assert.rejects(createEmployee(admin, { ...employeeInput, ...assignments }, stub.database), OrganizationNotFoundError);
      await assert.rejects(updateEmployee(admin, "employee-1", {
        ...employeeInput,
        password: "",
        ...assignments,
      }, stub.database), OrganizationNotFoundError);
    }
    assert.equal(stub.getCreateData(), undefined);
    assert.equal(stub.getUpdateData(), undefined);
  });

  it("keeps new and existing employees valid without Department or Designation assignments", async () => {
    const stub = createDatabaseStub();
    await createEmployee(admin, { ...employeeInput, departmentId: "", designationId: "" }, stub.database);
    assert.equal((stub.getCreateData()?.employee as { create: Record<string, unknown> }).create.departmentId, null);
    assert.equal((stub.getCreateData()?.employee as { create: Record<string, unknown> }).create.designationId, null);

    await updateEmployee(admin, "employee-1", {
      ...employeeInput,
      password: "",
      departmentId: "",
      designationId: null,
    }, stub.database);
    const update = (stub.getUpdateData()?.employee as { upsert: { update: Record<string, unknown> } }).upsert.update;
    assert.equal(update.departmentId, null);
    assert.equal(update.designationId, null);
  });

  it("tracks Department and Designation assignment changes by field name only", async () => {
    assert.deepEqual(changedEmployeeFieldNames(
      { departmentId: null, designationId: "designation-1" },
      { departmentId: "department-1", designationId: null },
    ), ["departmentId", "designationId"]);
    assert.deepEqual(employeeAuditMetadata(["departmentId", "designationId"]), {
      changedFields: ["departmentId", "designationId"],
    });
  });

  it("assigns, clears, and leaves Shift unassigned on employee create and update", async () => {
    const assigned = createDatabaseStub();
    await createEmployee(admin, { ...employeeInput, shiftId: "shift-1" }, assigned.database);
    const create = (assigned.getCreateData()?.employee as { create: Record<string, unknown> }).create;
    assert.equal(create.shiftId, "shift-1");

    await updateEmployee(admin, "employee-1", {
      ...employeeInput,
      password: "",
      shiftId: "",
      shiftEffectiveFrom: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    }, assigned.database);
    const update = (assigned.getUpdateData()?.employee as { upsert: { update: Record<string, unknown> } }).upsert.update;
    assert.equal(update.shiftId, null);

    const unassigned = createDatabaseStub();
    await createEmployee(admin, { ...employeeInput, shiftId: null }, unassigned.database);
    const unassignedCreate = (unassigned.getCreateData()?.employee as { create: Record<string, unknown> }).create;
    assert.equal(unassignedCreate.shiftId, null);
  });

  it("rejects nonexistent Shift IDs before writing", async () => {
    const stub = createDatabaseStub();
    await assert.rejects(createEmployee(admin, { ...employeeInput, shiftId: "missing" }, stub.database), ShiftNotFoundError);
    await assert.rejects(updateEmployee(admin, "employee-1", {
      ...employeeInput,
      password: "",
      shiftId: "missing",
    }, stub.database), ShiftNotFoundError);
    assert.equal(stub.getCreateData(), undefined);
    assert.equal(stub.getUpdateData(), undefined);
  });

  it("assigns weekday and weekend shifts with an effective date", async () => {
    const stub = createDatabaseStub();
    await createEmployee(admin, {
      ...employeeInput,
      shiftIds: ["weekday", "saturday"],
      shiftEffectiveFrom: "2026-01-01",
    }, stub.database);
    const employee = (stub.getCreateData()?.employee as { create: Record<string, unknown> }).create;
    assert.equal(employee.shiftId, "weekday");
    assert.deepEqual(employee.shiftAssignments, {
      create: [
        { shiftId: "weekday", effectiveFrom: new Date("2026-01-01T00:00:00.000Z") },
        { shiftId: "saturday", effectiveFrom: new Date("2026-01-01T00:00:00.000Z") },
      ],
    });
  });

  it("closes prior assignments and preserves their historical date range when shifts change", async () => {
    const stub = createDatabaseStub();
    await createEmployee(admin, {
      ...employeeInput,
      shiftIds: ["weekday", "saturday"],
      shiftEffectiveFrom: "2026-01-01",
    }, stub.database);
    await updateEmployee(admin, "employee-1", {
      ...employeeInput,
      password: "",
      shiftIds: ["weekday"],
      shiftEffectiveFrom: "2026-07-01",
    }, stub.database);
    const update = (stub.getUpdateData()?.employee as { upsert: { update: Record<string, unknown> } }).upsert.update;
    assert.equal(update.shiftId, "weekday");
    assert.deepEqual(update.shiftAssignments, {
      updateMany: {
        where: { effectiveTo: null },
        data: { effectiveTo: new Date("2026-06-30T00:00:00.000Z") },
      },
      create: [{ shiftId: "weekday", effectiveFrom: new Date("2026-07-01T00:00:00.000Z") }],
    });
  });

  it("rejects shift combinations with overlapping configured weekdays", async () => {
    const stub = createDatabaseStub();
    await assert.rejects(createEmployee(admin, {
      ...employeeInput,
      shiftIds: ["weekday", "overlap"],
      shiftEffectiveFrom: "2026-01-01",
    }, stub.database), ShiftAssignmentConflictError);
    assert.equal(stub.getCreateData(), undefined);
  });

  it("creates direct Supervisor and same-department Manager assignments", async () => {
    const stub = createReportingDatabaseStub();
    await createEmployee(admin, {
      ...employeeInput,
      departmentId: "department-1",
      supervisorId: "supervisor-1",
      managerId: "manager-1",
    }, stub.database);
    const createdEmployee = (stub.getCreateData()?.employee as { create: Record<string, unknown> }).create;
    assert.equal(createdEmployee.supervisorId, "supervisor-1");
    assert.equal(createdEmployee.managerId, "manager-1");
  });

  it("offers only active Supervisor and Department Manager reporting options to administrators", async () => {
    let query: Record<string, unknown> | undefined;
    const database = {
      employee: {
        findMany: async (input: Record<string, unknown>) => {
          query = input;
          return [
            { id: "supervisor-1", user: { role: Role.SUPERVISOR } },
            { id: "manager-1", user: { role: Role.DEPARTMENT_MANAGER } },
            { id: "employee-1", user: { role: Role.EMPLOYEE } },
          ];
        },
      },
    } as never;
    const options = await listEmployeeReportingOptions(admin, database);
    assert.deepEqual(options.supervisors.map(({ id }) => id), ["supervisor-1"]);
    assert.deepEqual(options.managers.map(({ id }) => id), ["manager-1"]);
    const hrOptions = await listEmployeeReportingOptions(hrAdmin, database);
    assert.deepEqual(hrOptions.supervisors.map(({ id }) => id), ["supervisor-1"]);
    assert.deepEqual(hrOptions.managers.map(({ id }) => id), ["manager-1"]);
    assert.deepEqual(query?.where, {
      user: { is: { isActive: true, role: { in: ["SUPERVISOR", "DEPARTMENT_MANAGER"] } } },
    });

    let queried = false;
    await assert.rejects(listEmployeeReportingOptions({ role: Role.EMPLOYEE }, {
      employee: { findMany: async () => { queried = true; return []; } },
    } as never), EmployeeAccessError);
    assert.equal(queried, false);
  });

  it("rejects self, wrong-role, inactive, and cross-department reporting assignments", async () => {
    const current = { id: "current-employee", departmentId: "department-1" };
    const invalidRefs = [
      { supervisorId: "missing" },
      { supervisorId: "current-employee" },
      { supervisorId: "manager-1" },
      { managerId: "supervisor-1" },
      { managerId: "manager-1", departmentId: "department-other" },
    ];
    for (const refs of invalidRefs) {
      const stub = createReportingDatabaseStub(current);
      await assert.rejects(updateEmployee(admin, "current-user", {
        ...employeeInput,
        password: "",
        ...refs,
      }, stub.database), EmployeeReportingAssignmentError);
      assert.equal(stub.getUpdateData(), undefined);
    }
    const inactiveDatabase = createReportingDatabaseStub();
    const withInactiveSupervisor = {
      ...inactiveDatabase,
      database: {
        employee: {
          findUnique: async ({ where }: { where: { id?: string } }) => where.id === "supervisor-1"
            ? { id: "supervisor-1", user: { role: Role.SUPERVISOR, isActive: false } }
            : { id: "manager-1", departmentId: "department-1", user: { role: Role.DEPARTMENT_MANAGER, isActive: true } },
        },
        user: { create: async () => ({}) },
        department: { findUnique: async () => null },
        designation: { findUnique: async () => null },
        shift: { findUnique: async () => null },
      } as never,
    };
    await assert.rejects(createEmployee(admin, { ...employeeInput, supervisorId: "supervisor-1" }, withInactiveSupervisor.database), EmployeeReportingAssignmentError);
  });

  it("includes Employee Shift assignment changes as field names in audit metadata", () => {
    assert.deepEqual(changedEmployeeFieldNames({ shiftId: null }, { shiftId: "shift-1" }), ["shiftId"]);
    assert.deepEqual(employeeAuditMetadata(["shiftId"]), { changedFields: ["shiftId"] });
  });

  it("records Supervisor and Manager assignments by field name only", () => {
    assert.deepEqual(changedEmployeeFieldNames(
      { supervisorId: null, managerId: "manager-old" },
      { supervisorId: "supervisor-1", managerId: null },
    ), ["managerId", "supervisorId"]);
  });

  it("rejects invalid optional identity/profile fields on the server", async () => {
    const stub = createDatabaseStub();
    await assert.rejects(createEmployee(admin, { ...employeeInput, nic: "x".repeat(121) }, stub.database), { name: "ZodError" });
    await assert.rejects(updateEmployee(admin, "employee-1", {
      ...employeeInput,
      password: "",
      profile: { email: "not-an-email" },
    }, stub.database), { name: "ZodError" });
    assert.equal(stub.getCreateData(), undefined);
    assert.equal(stub.getUpdateData(), undefined);
  });

  it("normalizes updated usernames and translates case-insensitive unique-index conflicts", async () => {
    const stub = createDatabaseStub();
    await createEmployee(admin, employeeInput, stub.database);
    await updateEmployee(admin, "employee-1", { ...employeeInput, username: "RAVI-UPDATED", password: "" }, stub.database);
    assert.equal(stub.getUpdateData()?.username, "ravi-updated");

    const database = {
      user: {
        create: async () => { throw { code: "P2002", meta: { target: "User_username_lower_key" } }; },
      },
    } as never;
    await assert.rejects(createEmployee(admin, { ...employeeInput, username: "RAVI.EMPLOYEE" }, database), (error: unknown) => {
      assert.ok(error instanceof EmployeeDuplicateError);
      assert.equal(error.field, "username");
      return true;
    });
  });

  it("translates duplicate Employee ID and NIC conflicts during update", async () => {
    for (const target of ["employeeId", "nic"]) {
      const database = {
        user: {
          update: async () => { throw { code: "P2002", meta: { target: [target] } }; },
        },
      } as never;
      await assert.rejects(updateEmployee(admin, "user-1", {
        ...employeeInput,
        password: "",
        nic: "NIC-123",
      }, database), (error: unknown) => {
        assert.ok(error instanceof EmployeeDuplicateError);
        assert.equal(error.field, target);
        return true;
      });
    }
  });

  it("uses a public select that never includes the password hash", () => {
    assert.equal("passwordHash" in publicEmployeeSelect, false);
  });

  it("searches by Employee name, Employee ID, or NIC with server-side pagination", async () => {
    let findArgs: Record<string, unknown> | undefined;
    let countWhere: Record<string, unknown> | undefined;
    const database = {
      employee: {
        findMany: async (args: Record<string, unknown>) => { findArgs = args; return []; },
        count: async ({ where }: { where: Record<string, unknown> }) => { countWhere = where; return 41; },
      },
    } as never;

    const result = await listEmployees(admin, { query: "nic-77", page: 3, pageSize: 10 }, database);

    assert.equal(result.total, 41);
    assert.equal(result.page, 3);
    assert.equal(result.pageSize, 10);
    assert.equal(result.pageCount, 5);
    assert.deepEqual(findArgs?.where, {
      OR: [
        { name: { contains: "nic-77", mode: "insensitive" } },
        { employeeId: { contains: "nic-77", mode: "insensitive" } },
        { nic: { contains: "nic-77", mode: "insensitive" } },
      ],
    });
    assert.equal(findArgs?.skip, 20);
    assert.equal(findArgs?.take, 10);
    assert.deepEqual(countWhere, findArgs?.where);
  });

  it("limits HR employee search to non-administrator accounts", async () => {
    let findWhere: Record<string, unknown> | undefined;
    const database = {
      employee: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => { findWhere = where; return []; },
        count: async () => 0,
      },
    } as never;

    await listEmployees(hrAdmin, {}, database);

    assert.deepEqual(findWhere, {
      user: { isNot: { role: { in: [Role.ADMIN, Role.HR_ADMINISTRATOR] } } },
    });
  });

  it("returns an explicit empty result and rejects unauthorized list access", async () => {
    const database = {
      employee: {
        findMany: async () => [],
        count: async () => 0,
      },
    } as never;

    const result = await listEmployees(admin, { query: "absent" }, database);
    assert.deepEqual(result.employees, []);
    assert.equal(result.total, 0);
    await assert.rejects(listEmployees({ role: Role.EMPLOYEE }, {}, database), EmployeeAccessError);
  });

  it("retrieves the Employee/Profile/User association and handles missing or unauthorized detail access", async () => {
    let receivedWhere: Record<string, unknown> | undefined;
    const employeeRow = {
      id: "employee-record-1",
      name: "Ravi Employee",
      employeeId: "EMP-1001",
      nic: "NIC-1001",
      epfId: null,
      etfId: null,
      userId: "user-1",
      profileCompletedAt: null,
      profileOnboardingRequired: true,
      user: { id: "user-1", email: "login@example.com", role: Role.EMPLOYEE, isActive: true, countryCode: "LK", timeZone: "Asia/Colombo" },
      profile: { email: "contact@example.com", permanentAddress: null },
    };
    const database = {
      employee: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => { receivedWhere = where; return employeeRow; },
      },
    } as never;

    const employee = await getEmployee(admin, "user-1", database);
    assert.equal(employee.user?.id, "user-1");
    assert.equal(employee.profile?.email, "contact@example.com");
    assert.deepEqual(receivedWhere, { OR: [{ userId: "user-1" }, { id: "user-1" }] });
    assert.equal("passwordHash" in (employee.user ?? {}), false);
    await assert.rejects(getEmployee(admin, "missing", { employee: { findFirst: async () => null } } as never), EmployeeNotFoundError);
    await assert.rejects(getEmployee({ role: Role.EMPLOYEE }, "user-1", database), EmployeeAccessError);
  });

  it("keeps audit payloads to changed field names rather than personal values", () => {
    const changedFields = changedEmployeeFieldNames(
      { name: "Before", nic: "SECRET-NIC", email: "before@example.com", loginUsername: "before.user" },
      { name: "After", nic: "SECRET-NIC", email: "after@example.com", loginUsername: "after.user" },
    );
    const metadata = employeeAuditMetadata(changedFields);

    assert.deepEqual(changedFields, ["email", "loginUsername", "name"]);
    assert.deepEqual(metadata, { changedFields: ["email", "loginUsername", "name"] });
    assert.equal(JSON.stringify(metadata).includes("SECRET-NIC"), false);
    assert.equal(JSON.stringify(metadata).includes("after@example.com"), false);
  });

  it("writes safe employee create/update audit events with actor, subject, and field names only", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const database = {
      attendanceAuditLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => { entries.push(data); return { id: "audit-1" }; },
      },
    } as never;

    await writeEmployeeAuditEvent(database, {
      employeeId: "user-1",
      actorId: "admin-1",
      actionType: "EMPLOYEE_UPDATED",
      changedFields: ["nic", "profile.permanentAddress"],
    });

    assert.equal(entries[0].employeeId, "user-1");
    assert.equal(entries[0].actorId, "admin-1");
    assert.equal(entries[0].actionType, "EMPLOYEE_UPDATED");
    assert.deepEqual(entries[0].previousValues, { changedFields: ["nic", "profile.permanentAddress"] });
    assert.deepEqual(entries[0].newValues, { changedFields: ["nic", "profile.permanentAddress"] });
    assert.equal(JSON.stringify(entries).includes("NIC-SECRET-VALUE"), false);
  });
});