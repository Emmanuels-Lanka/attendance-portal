ALTER TABLE "AttendanceCorrectionRequest"
ADD COLUMN "attendanceDate" DATE;

UPDATE "AttendanceCorrectionRequest" AS correction
SET "attendanceDate" = daily."date"
FROM "AttendanceDaily" AS daily
WHERE correction."dailyAttendanceId" = daily."id"
  AND correction."attendanceDate" IS NULL;

CREATE INDEX "AttendanceCorrectionRequest_employeeId_attendanceDate_status_idx"
ON "AttendanceCorrectionRequest"("employeeId", "attendanceDate", "status");
