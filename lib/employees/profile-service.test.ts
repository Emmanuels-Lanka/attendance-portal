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
  motherId: "MOTHER-100",
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

  it("accepts optional spouse and gender fields and normalizes blank values", () => {
    const parsed = employeeProfileCompletionSchema.parse({
      ...validProfile,
      spouseName: "",
      spouseId: undefined,
      gender: "",
      genderCustom: "",
    });

    assert.equal(parsed.email, "employee@example.com");
    assert.equal(parsed.spouseName, null);
    assert.equal(parsed.spouseId, null);
    assert.equal(parsed.gender, null);
    assert.equal(parsed.genderCustom, null);
    assert.equal(parsed.fatherName, null);
    assert.equal(parsed.fatherId, null);
    assert.equal(parsed.fatherContactNumber, null);
  });

  it("requires both name and ID for at least one parent, while allowing either complete group", () => {
    const emptyParents = { motherName: "", motherId: "", fatherName: "", fatherId: "" };
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, ...emptyParents }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, fatherName: "Father", fatherId: "FATHER-1", motherName: "", motherId: "" }).success, true);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, fatherName: "Father", fatherId: "FATHER-1" }).success, true);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, fatherName: "Father", fatherId: "FATHER-1", motherName: "Mother", motherId: "MOTHER-1" }).success, true);
  });

  it("rejects each partial parent group, including contact-only details", () => {
    const completeMother = { motherName: "Mother", motherId: "MOTHER-1" };
    const completeFather = { fatherName: "Father", fatherId: "FATHER-1" };
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, ...completeFather, motherName: "Mother", motherId: "" }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, ...completeFather, motherName: "", motherId: "MOTHER-1" }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, ...completeMother, fatherName: "Father", fatherId: "" }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, ...completeMother, fatherName: "", fatherId: "FATHER-1" }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, motherName: "", motherId: "", motherContactNumber: "+94770000000", fatherName: "", fatherId: "" }).success, false);
  });

  it("keeps parent contact optional, normalizes blanks, and preserves field length limits", () => {
    const parsed = employeeProfileCompletionSchema.parse({ ...validProfile, motherContactNumber: "", fatherName: "", fatherId: "", fatherContactNumber: "" });
    assert.equal(parsed.motherContactNumber, null);
    assert.equal(parsed.fatherName, null);
    assert.equal(parsed.fatherId, null);
    assert.equal(parsed.fatherContactNumber, null);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, motherName: "M".repeat(121) }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, motherId: "I".repeat(121) }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, motherContactNumber: "1".repeat(65) }).success, false);
  });

  it("validates optional canonical and custom gender values", () => {
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
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, gender: undefined }).success, true);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, gender: "UNKNOWN" }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, gender: "CUSTOM", genderCustom: "   " }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, gender: "MALE", genderCustom: "stale" }).success, false);
    assert.equal(employeeProfileCompletionSchema.safeParse({ ...validProfile, gender: "CUSTOM", genderCustom: "G".repeat(121) }).success, false);
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
    const completed = createProfileDatabase({ onboardingRequired: false, profileCompletedAt: completedAt });

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
    assert.equal(stub.getProfile()?.gender, null);
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