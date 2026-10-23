import { matchesCronBearerSecret } from "./cron-auth";
import type { AttendanceReconciliationSummary } from "./daily-reconciliation-queue";

type Worker = (now?: Date) => Promise<AttendanceReconciliationSummary>;

export function createDailyReconciliationHandler(
  run: Worker,
  getSecret: () => string | undefined,
  getNow: () => Date = () => new Date(),
) {
  return async function GET(request: Request) {
    const secret = getSecret();
    if (!secret) {
      return Response.json({ ok: false, error: "Attendance reconciliation is not configured." }, { status: 503 });
    }
    if (!matchesCronBearerSecret(request.headers.get("authorization"), secret)) {
      return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
    }
    if (new URL(request.url).search !== "") {
      return Response.json({ ok: false, error: "Query parameters are not supported." }, { status: 400 });
    }

    try {
      const summary = await run(getNow());
      if (summary.pending > 0 || summary.retried > 0 || summary.deadLettered > 0 || summary.unlinkedEmployees > 0) {
        console.error("Attendance reconciliation completed with queued or excluded work", {
          pending: summary.pending,
          retried: summary.retried,
          deadLettered: summary.deadLettered,
          unlinkedEmployees: summary.unlinkedEmployees,
          failureCategories: summary.failureCategories,
        });
      }
      if (summary.retried > 0 || summary.deadLettered > 0) {
        return Response.json({ ok: false, summary }, { status: 500 });
      }
      return Response.json({ ok: true, summary }, { status: 200 });
    } catch (error) {
      console.error("Attendance reconciliation worker failed", {
        errorName: error instanceof Error ? error.name : "Unknown error",
      });
      return Response.json({ ok: false, error: "Attendance reconciliation failed." }, { status: 500 });
    }
  };
}
