import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  completeEmployeeProfileForUser,
  EmployeeProfileCompletionError,
  employeeProfileCompletionSchema,
  getEmployeeProfileOnboardingStatus,
  requiresProfileCompletion,
} from "./profile-service";

const completedAt = new Date("2026-10-03T10:00:00.000Z");

const validProfile = {
  permanentAddress: "12 Permanent Road, Colombo",
  currentAddress: "34 Current Avenue, Colombo",
  emergencyContactName: "Contact Person",
  emergencyContactId: "CONTACT-100",
  emergencyContactAddress: "56 Emergency Lane, Colombo",
  emergencyContactPhone: "+94770000000",
  emergencyContactRelationship: "Sibling",
  contactNumber: "+94771111111",
  email: "EMPLOYEE@EXAMPLE.COM",
  linkedInId: "employee-profile-id",
  dateOfBirth: "1990-04-12",
  maritalStatus: "Single",
  spouseName: "Spouse Name",
  spouseId: "SPOUSE-100",
  motherName: "Mother Name",
  motherContactNumber: "+94772222222",
  gender: "MALE",
};

function createProfileDatabase(options: { userId?: string; onboardingRequired?: boolean; profileCompletedAt?: Date | null } = {}) {
  const employee = {
    id: "employee-record-1",
    userId: options.userId ?? "user-1",
    profileOnboardingRequired: options.onboardingRequired ?? true,
    profileCompletedAt: options.profileCompletedAt ?? null,
  };
  let profile: Record<string, unknown> | undefined;
  let lookup: Record<string, unknown> | undefined;
  let updateWhere: Record<string, unknown> | undefined;
  const auditEntries: Array<Record<string, unknown>> = [];
  let transactionCount = 0;
  let inTransaction = false;

  const database = {
    employee: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        lookup = where;
        return where.userId === employee.userId ? { ...employee } : null;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        assert.equal(inTransaction, true);
        updateWhere = where;
        if (where.id !== employee.id || where.userId !== employee.userId || employee.profileOnboardingRequired !== true || employee.profileCompletedAt !== null) {
          return { count: 0 };
        }
        employee.profileCompletedAt = data.profileCompletedAt as Date;
        employee.profileOnboardingRequired = data.profileOnboardingRequired as boolean;
        return { count: 1 };
      },
    },
    employeeProfile: {
      upsert: async ({ where, create, update }: { where: { employeeRecordId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        assert.equal(inTransaction, true);
        assert.equal(where.employeeRecordId, employee.id);
        profile = { ...(profile ?? create), ...update };
        return { employeeRecordId: employee.id };
      },
    },
    attendanceAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        assert.equal(inTransaction, true);
        auditEntries.push(data);
        return { id: `audit-${auditEntries.length}` };
      },
    },
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => {
      transactionCount += 1;
      inTransaction = true;
      try {
        return await operation(database);
      } finally {
        inTransaction = false;
      }
    },
  } as never;

  return {
    database,
    employee,
    getProfile: () => profile,
    getLookup: () => lookup,
    getUpdateWhere: () => updateWhere,
    getAuditEntries: () => auditEntries,
    getTransactionCount: () => transactionCount,
  };
}

describe("employee profile validation", () => {
  it("requires every confirmed mandatory field", () => {
    const mandatoryFields = [
      "permanentAddress",
      "currentAddress",
      "emergencyContactName",
      "emergencyContactId",
      "emergencyContactAddress",
      "emergencyContactPhone",
      "emergencyContactRelationship",
      "contactNumber",
      "email",
      "linkedInId",
      "dateOfBirth",
      "maritalStatus",
    ];

    for (const field of mandatoryFields) {
      const input = { ...validProfile };
      delete input[field as keyof typeof input];
      assert.equal(employeeProfileCompletionSchema.safeParse(input).success, false, `${field} must be required`);
    }
  });

  it("accepts optional spouse fields and normalizes blank values", () => {
    const parsed = employeeProfileCompletionSchema.parse({
      ...validProfile,
      spouseName: "",
      spouseId: undefined,
      motherId: "",
      fatherName: "",
      fatherId: "",
      fatherContactNumber: "",
    });

    assert.equal(parsed.email, "employee@example.com");
    assert.equal(parsed.spouseName, null);
    assert.equal(parsed.spouseId, null);
    assert.equal(parsed.motherId, null);
    assert.equal(parsed.fatherName, null);
    assert.equal(parsed.fatherId, null);
    assert.equal(parsed.fatherContactNumber, null);
  });

  it("requires one parent name and contact pair, with IDs optional", () => {
    const emptyParents = {
      motherName: "",
      motherId: "",
      motherContactNumber: "",
      fatherName: "",
      fatherId: "",
      fatherContactNumber: "",
    };
    const missingParent = employeeProfileCompletionSchema.safeParse({ ...validProfile, ...emptyParents });
    assert.equal(missingParent.success, false);
    if (!missingParent.success) {
      assert.ok(missingParent.error.issues.some((issue) => issue.message === "Enter information for at least one parent."));
    }
    assert.equal(employeeProfileCompletionSchema.safeParse({
      ...validProfile,
      motherName: "Mother",
      motherId: "",
      motherContactNumber: "+94770000000",
      fatherName: "",
      fatherId: "",
      fatherContactNumber: "",
    }).success, true);
    assert.equal(employeeProfileCompletionSchema.safeParse({
      ...validProfile,
      motherName: "",
      motherId: "",
      motherContactNumber: "",
      fatherName: "Father",
      fatherId: "",
      fatherContactNumber: "+94771111111",
    }).success, true);
    assert.equal(employeeProfileCompletionSchema.safeParse({
      ...validProfile,
      fatherName: "Father",
      fatherId: "FATHER-1",
      fatherContactNumber: "+94771111111",
    }).success, true);
    assert.equal(employeeProfileCompletionSchema.safeParse({
      ...validProfile,
      motherName: "Mother",
      motherId: "MOTHER-1",
      motherContactNumber: "+94770000000",
    }).success, true);
  });

  it("rejects parent groups without both a name and contact number", () => {
    const cases = [
      { motherName: "Mother", motherContactNumber: "", fatherName: "", fatherContactNumber: "" },
      { motherName: "", motherContactNumber: "+94770000000", fatherName: "", fatherContactNumber: "" },
      { motherName: "", motherId: "MOTHER-1", motherContactNumber: "", fatherName: "", fatherContactNumber: "" },
      { motherName: "", motherContactNumber: "", fatherName: "Father", fatherContactNumber: "" },
      { motherName: "", motherContactNumber: "", fatherName: "", fatherContactNumber: "+94771111111" },
      { motherName: "", motherContactNumber: "", fatherName: "", fatherId: "FATHER-1", fatherContactNumber: "" },
    ];

    for (const parentFields of cases) {
      const result = employeeProfileCompletionSchema.safeParse({ ...validProfile, ...parentFields });
      assert.equal(result.success, false);
      if (!result.success) {
        assert.deepEqual(result.error.issues.map((issue) => issue.message), ["Enter information for at least one parent."]);
      }
    }
  });

  it("normalizes optional parent IDs and preserves parent length limits", () => {
    const parsed = employeeProfileCompletionSchema.parse({ ...validProfile, motherId: "", fatherName: "", fatherId: "", fatherContactNumber: "" });
    assert.equal(parsed.motherId, null);
    assert.equal(parsed.fatherName, null);
    assert.equal(parsed.fatherId, null);
    assert.equal(parsed.fatherContactNumber, null);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, motherName: "M".repeat(121) }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, motherId: "I".repeat(121) }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, motherContactNumber: "1".repeat(65) }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, motherId: "I".repeat(120) }).success, true);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, motherName: "M".repeat(120) }).success, true);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, motherContactNumber: "1".repeat(64) }).success, true);
  });

  it("requires each canonical gender choice and validates custom text", () => {
    for (const gender of ["MALE", "FEMALE", "PREFER_NOT_TO_SAY", "CUSTOM"]) {
      const result = employeeProfileCompletionSchema.safeParse({
        ...validProfile,
        gender,
        genderCustom: gender === "CUSTOM" ? " Non-binary " : "",
      });
      assert.equal(result.success, true, `${gender} should be accepted`);
      if (result.success) {
        assert.equal(result.data.gender, gender);
        assert.equal(result.data.genderCustom, gender === "CUSTOM" ? "Non-binary" : null);
      }
    }
    for (const gender of [undefined, "", null]) {
      const result = employeeProfileCompletionSchema.safeParse({ ...validProfile, gender });
      assert.equal(result.success, false);
      if (!result.success) assert.ok(result.error.issues.some((issue) => issue.message === "Choose a gender option."));
    }
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, gender: "UNKNOWN" }).success, false);
    const missingCustom = employeeProfileCompletionSchema.safeParse({ ...validProfile, gender: "CUSTOM", genderCustom: "   " });
    assert.equal(missingCustom.success, false);
    if (!missingCustom.success) {
      assert.ok(missingCustom.error.issues.some((issue) => issue.message === "Specify your gender when selecting Custom."));
    }
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, gender: "MALE", genderCustom: "stale" }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, gender: "CUSTOM", genderCustom: "G".repeat(121) }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, gender: "CUSTOM", genderCustom: "G".repeat(120) }).success, true);
  });

  it("rejects invalid dates and future dates", () => {
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, dateOfBirth: "1990-02-31" }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, dateOfBirth: "2999-01-01" }).success, false);
  });
});

describe("employee profile completion service", () => {
  it("requires profile completion for every onboarding-required non-admin role", () => {
    assert.equal(requiresProfileCompletion("EMPLOYEE", true), true);
    assert.equal(requiresProfileCompletion("HR_ADMINISTRATOR", true), true);
    assert.equal(requiresProfileCompletion("DEPARTMENT_MANAGER", true), true);
    assert.equal(requiresProfileCompletion("SUPERVISOR", true), true);
    assert.equal(requiresProfileCompletion("EMPLOYEE", false), false);
    assert.equal(requiresProfileCompletion("ADMIN", true), false);
  });

  it("requires completion only when the Employee record is explicitly flagged", async () => {
    const pending = createProfileDatabase();
    const legacy = createProfileDatabase({ onboardingRequired: false });
    const completed = createProfileDatabase({ onboardingRequired: true, profileCompletedAt: completedAt });

    assert.equal((await getEmployeeProfileOnboardingStatus("user-1", pending.database)).required, true);
    assert.equal((await getEmployeeProfileOnboardingStatus("user-1", legacy.database)).required, false);
    assert.equal((await getEmployeeProfileOnboardingStatus("user-1", completed.database)).required, false);
    assert.equal((await getEmployeeProfileOnboardingStatus("unknown-user", pending.database)).required, false);
  });

  it("leaves legacy users exempt and does not mark them complete", async () => {
    const stub = createProfileDatabase({ onboardingRequired: false });

    assert.deepEqual(await getEmployeeProfileOnboardingStatus("user-1", stub.database), { required: false, completedAt: null });
    await assert.rejects(completeEmployeeProfileForUser("user-1", validProfile, stub.database, completedAt), EmployeeProfileCompletionError);
    assert.equal(stub.employee.profileCompletedAt, null);
    assert.equal(stub.getTransactionCount(), 1);
  });

  it("keeps completion timestamp null when required data is invalid", async () => {
    const stub = createProfileDatabase();

    await assert.rejects(completeEmployeeProfileForUser("user-1", { ...validProfile, contactNumber: "" }, stub.database, completedAt), { name: "ZodError" });
    assert.equal(stub.employee.profileCompletedAt, null);
    assert.equal(stub.getProfile(), undefined);
    assert.equal(stub.getTransactionCount(), 0);
  });

  it("saves the authenticated user's profile and marks it complete atomically", async () => {
    const stub = createProfileDatabase();

    const result = await completeEmployeeProfileForUser("user-1", {
      ...validProfile,
      motherName: "Mother Name",
      motherId: "MOTHER-100",
      motherContactNumber: "+94772222222",
      fatherName: "Father Name",
      fatherId: "FATHER-100",
      fatherContactNumber: "+94773333333",
      employeeRecordId: "employee-victim",
      userId: "user-victim",
    }, stub.database, completedAt);

    assert.equal(result.profileCompletedAt, completedAt);
    assert.equal(stub.employee.profileCompletedAt, completedAt);
    assert.equal(stub.employee.profileOnboardingRequired, false);
    assert.deepEqual(stub.getLookup(), { userId: "user-1" });
    assert.deepEqual(stub.getUpdateWhere(), {
      id: "employee-record-1",
      userId: "user-1",
      profileOnboardingRequired: true,
      profileCompletedAt: null,
    });
    assert.equal(stub.getProfile()?.employeeRecordId, "employee-record-1");
    assert.equal(stub.getProfile()?.email, "employee@example.com");
    assert.equal(stub.getProfile()?.motherId, "MOTHER-100");
    assert.equal(stub.getProfile()?.fatherId, "FATHER-100");
    assert.equal(stub.getProfile()?.gender, "MALE");
    assert.equal(stub.getProfile()?.genderCustom, null);
    assert.equal("password" in (stub.getProfile() ?? {}), false);
    assert.deepEqual(stub.getAuditEntries(), [{ employeeId: "user-1", actorId: "user-1", actionType: "EMPLOYEE_PROFILE_COMPLETED" }]);
    assert.equal(await getEmployeeProfileOnboardingStatus("user-1", stub.database).then(({ required }) => required), false);
  });

  it("persists every supported gender choice and trimmed custom text", async () => {
    for (const gender of ["MALE", "FEMALE", "PREFER_NOT_TO_SAY", "CUSTOM"] as const) {
      const stub = createProfileDatabase();
      await completeEmployeeProfileForUser("user-1", {
        ...validProfile,
        gender,
        genderCustom: gender === "CUSTOM" ? "  Non-binary  " : "",
      }, stub.database, completedAt);
      assert.equal(stub.getProfile()?.gender, gender);
      assert.equal(stub.getProfile()?.genderCustom, gender === "CUSTOM" ? "Non-binary" : null);
    }
  });

  it("does not permit a second completion after the employee is complete", async () => {
    const stub = createProfileDatabase({ onboardingRequired: false, profileCompletedAt: completedAt });

    await assert.rejects(completeEmployeeProfileForUser("user-1", validProfile, stub.database, completedAt), EmployeeProfileCompletionError);
    assert.equal(stub.employee.profileCompletedAt, completedAt);
  });
});