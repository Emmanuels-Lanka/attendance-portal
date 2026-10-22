CREATE TABLE "employee_shift_assignments" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_shift_assignments_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "employee_shift_assignments"
ADD CONSTRAINT "employee_shift_assignments_effective_dates_check"
CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");

INSERT INTO "employee_shift_assignments" ("id", "employeeId", "shiftId", "effectiveFrom")
SELECT 'legacy-shift-' || "id", "id", "shiftId", DATE '0001-01-01'
FROM "Employee"
WHERE "shiftId" IS NOT NULL;

CREATE UNIQUE INDEX "employee_shift_assignments_employeeId_shiftId_effectiveFrom_key"
ON "employee_shift_assignments"("employeeId", "shiftId", "effectiveFrom");

CREATE INDEX "employee_shift_assignments_employeeId_effectiveFrom_effectiveTo_idx"
ON "employee_shift_assignments"("employeeId", "effectiveFrom", "effectiveTo");

CREATE INDEX "employee_shift_assignments_shiftId_idx"
ON "employee_shift_assignments"("shiftId");

ALTER TABLE "employee_shift_assignments"
ADD CONSTRAINT "employee_shift_assignments_employeeId_fkey"
FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "employee_shift_assignments"
ADD CONSTRAINT "employee_shift_assignments_shiftId_fkey"
FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
