CREATE TYPE "DailyAttendanceMode" AS ENUM ('OFFICE', 'WFH', 'MIXED');

ALTER TABLE "attendance_daily"
ADD COLUMN "mode" "DailyAttendanceMode";

WITH "session_modes" AS (
  SELECT
    daily."id",
    COUNT(DISTINCT session."mode") AS "modeCount",
    MIN(session."mode"::TEXT) AS "singleMode"
  FROM "attendance_daily" AS daily
  JOIN "Employee" AS employee ON employee."id" = daily."employeeId"
  JOIN "User" AS account ON account."id" = employee."userId"
  JOIN "AttendanceRecord" AS record ON record."employeeId" = account."id"
  JOIN "WorkSession" AS session ON session."recordId" = record."id"
  WHERE (session."startAt" AT TIME ZONE account."timeZone")::DATE = daily."date"
    OR (session."endAt" AT TIME ZONE account."timeZone")::DATE = daily."date"
  GROUP BY daily."id"
)
UPDATE "attendance_daily" AS daily
SET "mode" = CASE
  WHEN session_modes."modeCount" > 1 THEN 'MIXED'::"DailyAttendanceMode"
  ELSE session_modes."singleMode"::"DailyAttendanceMode"
END
FROM "session_modes" AS session_modes
WHERE daily."id" = session_modes."id";

WITH "raw_modes" AS (
  SELECT
    daily."id",
    COUNT(DISTINCT raw."workMode") AS "modeCount",
    MIN(raw."workMode"::TEXT) AS "singleMode"
  FROM "attendance_daily" AS daily
  JOIN "Employee" AS employee ON employee."id" = daily."employeeId"
  JOIN "User" AS account ON account."id" = employee."userId"
  JOIN "attendance_raw" AS raw ON raw."employeeId" = employee."id"
  WHERE (raw."timestamp" AT TIME ZONE account."timeZone")::DATE = daily."date"
    AND raw."workMode" IS NOT NULL
    AND daily."mode" IS NULL
  GROUP BY daily."id"
)
UPDATE "attendance_daily" AS daily
SET "mode" = CASE
  WHEN raw_modes."modeCount" > 1 THEN 'MIXED'::"DailyAttendanceMode"
  ELSE raw_modes."singleMode"::"DailyAttendanceMode"
END
FROM "raw_modes" AS raw_modes
WHERE daily."id" = raw_modes."id"
  AND daily."mode" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "Employee" AS employee
    JOIN "User" AS account ON account."id" = employee."userId"
    JOIN "AttendanceRecord" AS record ON record."employeeId" = account."id"
    JOIN "WorkSession" AS session ON session."recordId" = record."id"
    WHERE employee."id" = daily."employeeId"
      AND (
        (session."startAt" AT TIME ZONE account."timeZone")::DATE = daily."date"
        OR (session."endAt" AT TIME ZONE account."timeZone")::DATE = daily."date"
      )
  );
