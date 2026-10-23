CREATE TYPE "AttendanceDailyCalculationTaskStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'RETRY_WAIT',
    'COMPLETED',
    'PROTECTED',
    'DEAD_LETTER'
);

CREATE TABLE "attendance_daily_calculation_tasks" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "attendanceDate" DATE NOT NULL,
    "timeZone" TEXT NOT NULL,
    "lastPunchId" TEXT NOT NULL,
    "requestedVersion" INTEGER NOT NULL DEFAULT 1,
    "completedVersion" INTEGER NOT NULL DEFAULT 0,
    "claimedVersion" INTEGER,
    "status" "AttendanceDailyCalculationTaskStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "lastErrorCategory" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_daily_calculation_tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attendance_daily_calculation_tasks_requestedVersion_check" CHECK ("requestedVersion" > 0),
    CONSTRAINT "attendance_daily_calculation_tasks_completedVersion_check" CHECK ("completedVersion" >= 0),
    CONSTRAINT "attendance_daily_calculation_tasks_attempts_check" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "attendance_daily_calculation_tasks_employeeId_attendanceDat_key"
ON "attendance_daily_calculation_tasks"("employeeId", "attendanceDate");

CREATE INDEX "attendance_daily_calculation_tasks_status_availableAt_creat_idx"
ON "attendance_daily_calculation_tasks"("status", "availableAt", "createdAt");

CREATE INDEX "attendance_daily_calculation_tasks_status_leaseExpiresAt_idx"
ON "attendance_daily_calculation_tasks"("status", "leaseExpiresAt");

ALTER TABLE "attendance_daily_calculation_tasks"
ADD CONSTRAINT "attendance_daily_calculation_tasks_employeeId_fkey"
FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "attendance_daily_calculation_tasks"
ADD CONSTRAINT "attendance_daily_calculation_tasks_lastPunchId_fkey"
FOREIGN KEY ("lastPunchId") REFERENCES "attendance_raw"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "attendance_daily_calculation_task_events" (
    "taskId" TEXT NOT NULL,
    "punchId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_daily_calculation_task_events_pkey" PRIMARY KEY ("taskId", "punchId")
);

CREATE INDEX "attendance_daily_calculation_task_events_punchId_idx"
ON "attendance_daily_calculation_task_events"("punchId");

ALTER TABLE "attendance_daily_calculation_task_events"
ADD CONSTRAINT "attendance_daily_calculation_task_events_taskId_fkey"
FOREIGN KEY ("taskId") REFERENCES "attendance_daily_calculation_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "attendance_daily_calculation_task_events"
ADD CONSTRAINT "attendance_daily_calculation_task_events_punchId_fkey"
FOREIGN KEY ("punchId") REFERENCES "attendance_raw"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
