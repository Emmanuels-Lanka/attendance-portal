import { timingSafeEqual } from "node:crypto";
import {
  DailyCalculationCapacityError,
  DailyCalculationRequestError,
  dailyCalculationRequestSchema,
  type DailyCalculationRequest,
} from "./daily-calculation-job";

type DailyCalculationSummary = {
  lockAcquired: boolean;
  scanned: number;
  calculated: number;
  skippedApprovedCorrections: number;
  unlinkedEmployees: number;
  skippedIneligible: number;
  failed: number;
  failureCategories: Record<string, number>;
};

type DailyCalculationRunner = (
  input: DailyCalculationRequest,
  now?: Date,
) => Promise<DailyCalculationSummary>;

function matchesBearerSecret(header: string | null, secret: string) {
  const token = header?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!token) return false;
  const expectedBytes = Buffer.from(secret, "utf8");
  const tokenBytes = Buffer.from(token, "utf8");
  return expectedBytes.length === tokenBytes.length && timingSafeEqual(expectedBytes, tokenBytes);
}

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status });
}

export function createDailyCalculationHandler(
  run: DailyCalculationRunner,
  getSecret: () => string | undefined,
  getNow: () => Date = () => new Date(),
) {
  return async function GET(request: Request) {
    const secret = getSecret();
    if (!secret) return json({ ok: false, error: "Daily attendance calculation is not configured." }, 503);
    if (!matchesBearerSecret(request.headers.get("authorization"), secret)) {
      return json({ ok: false, error: "Unauthorized." }, 401);
    }

    const params = new URL(request.url).searchParams;
    const queryKeys = [...new Set(params.keys())];
    const dates = params.getAll("date");
    if (queryKeys.some((key) => key !== "date") || dates.length > 1) {
      return json({ ok: false, error: "Only one optional date parameter is supported." }, 400);
    }
    const parsedInput = dailyCalculationRequestSchema.safeParse(
      dates.length === 0 ? {} : { date: dates[0] },
    );
    if (!parsedInput.success) {
      return json({
        ok: false,
        error: parsedInput.error.issues[0]?.message ?? "Invalid calculation request.",
      }, 400);
    }

    try {
      const summary = await run(parsedInput.data, getNow());
      if (!summary.lockAcquired) {
        return json({ ok: false, error: "Another daily calculation is currently running." }, 409);
      }
      if (summary.failed > 0) {
        console.error("Daily attendance calculation completed with employee failures", {
          failed: summary.failed,
          failureCategories: summary.failureCategories,
        });
        return json({ ok: false, summary }, 500);
      }
      return json({ ok: true, summary }, 200);
    } catch (error) {
      if (error instanceof DailyCalculationRequestError) {
        return json({ ok: false, error: error.message }, 400);
      }
      if (error instanceof DailyCalculationCapacityError) {
        console.error("Daily attendance calculation exceeded its employee batch limit");
        return json({ ok: false, error: "The employee batch limit was exceeded; operator action is required." }, 503);
      }
      console.error("Daily attendance calculation failed; transaction was rolled back", {
        errorName: error instanceof Error ? error.name : "Unknown error",
      });
      return json({ ok: false, error: "Daily attendance calculation failed; no results were committed." }, 500);
    }
  };
}
