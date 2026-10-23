import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const migration = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20261003000002_employee_data_foundation/migration.sql",
), "utf8");
const profileMigration = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20261003000003_employee_profile_completion/migration.sql",
), "utf8");
const genderMigration = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20261024000000_employee_profile_gender/migration.sql",
), "utf8");
const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

describe("Employee foundation migration", () => {
  it("backfills each existing User using its existing ID and available name/code only", () => {
    assert.match(migration, /INSERT INTO "Employee" \("id", "name", "employeeId", "userId", "createdAt", "updatedAt"\)/);
    assert.match(migration, /SELECT 'employee_' \|\| "id", "name", "employeeCode", "id", "createdAt", "updatedAt"\s+FROM "User"/);
    assert.doesNotMatch(migration, /COALESCE|UPDATE "User"|DROP TABLE|TRUNCATE/);
  });

  it("adds unique constraints without changing attendance tables or User IDs", () => {
    assert.match(migration, /CREATE UNIQUE INDEX "Employee_employeeId_key"/);
    assert.match(migration, /CREATE UNIQUE INDEX "Employee_nic_key"/);
    assert.match(migration, /CREATE UNIQUE INDEX "Employee_userId_key"/);
    assert.doesNotMatch(migration, /ALTER TABLE "AttendanceRecord"|ALTER TABLE "WorkSession"|ALTER TABLE "User"\s+ALTER COLUMN "id"/);
  });

  it("keeps legacy employees exempt and creates no fabricated profile data", () => {
    assert.match(profileMigration, /ADD COLUMN "profileOnboardingRequired" BOOLEAN NOT NULL DEFAULT false/);
    assert.match(profileMigration, /CREATE TABLE "EmployeeProfile"/);
    assert.match(profileMigration, /PRIMARY KEY \("employeeRecordId"\)/);
    assert.match(profileMigration, /REFERENCES "Employee"\("id"\)/);
    assert.doesNotMatch(profileMigration, /INSERT INTO "EmployeeProfile"|UPDATE "Employee"/);
    assert.doesNotMatch(profileMigration, /ALTER TABLE "AttendanceRecord"|ALTER TABLE "WorkSession"|ALTER TABLE "User"/);
  });

  it("adds nullable gender columns in a new migration without defaults or data backfills", () => {
    assert.match(schema, /gender\s+String\?\s+@db\.VarChar\(32\)/);
    assert.match(schema, /genderCustom\s+String\?\s+@db\.VarChar\(120\)/);
    assert.match(genderMigration, /ALTER TABLE "EmployeeProfile"\s+ADD COLUMN "gender" VARCHAR\(32\),\s+ADD COLUMN "genderCustom" VARCHAR\(120\);/);
    assert.doesNotMatch(genderMigration, /NOT NULL|DEFAULT|UPDATE\s+"EmployeeProfile"|INSERT INTO\s+"EmployeeProfile"/i);
    assert.doesNotMatch(profileMigration, /gender/);
  });
});