import { createDailyReconciliationHandler } from "@/lib/attendance/daily-reconciliation-http";
import { runAttendanceReconciliationWorker } from "@/lib/attendance/daily-reconciliation-queue";

export const maxDuration = 60;

export const GET = createDailyReconciliationHandler(
  runAttendanceReconciliationWorker,
  () => process.env.CRON_SECRET,
);
