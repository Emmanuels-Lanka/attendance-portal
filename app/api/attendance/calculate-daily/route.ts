import { createDailyCalculationHandler } from "@/lib/attendance/daily-calculation-http";
import { runDailyAttendanceCalculation } from "@/lib/attendance/daily-calculation-job";

export const runtime = "nodejs";
export const maxDuration = 60;

export const GET = createDailyCalculationHandler(
  runDailyAttendanceCalculation,
  () => process.env.CRON_SECRET,
);
