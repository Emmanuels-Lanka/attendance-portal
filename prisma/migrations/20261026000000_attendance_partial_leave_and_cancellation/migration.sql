CREATE TYPE "LeaveDurationMode" AS ENUM ('FULL_DAY', 'HALF_DAY', 'TIME_BASED');
CREATE TYPE "LeaveHalfDayPeriod" AS ENUM ('MORNING', 'AFTERNOON');
CREATE TYPE "LeaveCancellationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "LeaveType"
ADD COLUMN "durationMode" "LeaveDurationMode" NOT NULL DEFAULT 'FULL_DAY';

ALTER TABLE "LeaveRequest"
ADD COLUMN "startTime" TIME(0),
ADD COLUMN "endTime" TIME(0),
ADD COLUMN "halfDayPeriod" "LeaveHalfDayPeriod",
ADD COLUMN "cancellationStatus" "LeaveCancellationStatus",
ADD COLUMN "cancellationReason" TEXT,
ADD COLUMN "cancellationRequestedAt" TIMESTAMPTZ(3),
ADD COLUMN "cancellationApprovalStage" TEXT,
ADD COLUMN "cancellationCurrentApproverId" TEXT,
ADD COLUMN "cancellationReviewedById" TEXT,
ADD COLUMN "cancellationReviewedAt" TIMESTAMPTZ(3),
ADD COLUMN "cancellationDecisionReason" TEXT,
ADD COLUMN "cancellationRequestedById" TEXT;

ALTER TABLE "LeaveRequest"
ADD CONSTRAINT "LeaveRequest_cancellationCurrentApproverId_fkey"
FOREIGN KEY ("cancellationCurrentApproverId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "LeaveRequest_cancellationReviewedById_fkey"
FOREIGN KEY ("cancellationReviewedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "LeaveRequest_cancellationRequestedById_fkey"
FOREIGN KEY ("cancellationRequestedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "LeaveRequest_cancellationStatus_cancellationApprovalStage_cancellationCurrentApproverId_idx"
ON "LeaveRequest"("cancellationStatus", "cancellationApprovalStage", "cancellationCurrentApproverId");

ALTER TABLE "Shift"
ADD COLUMN "breakStartTime" TIME(0);

ALTER TABLE "attendance_daily"
ADD COLUMN "leaveMinutes" INTEGER,
ADD COLUMN "statusReason" TEXT;
