import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { cache } from "react";

type ServerTimingContext = {
  requestId: string;
  route: string;
};

const requestIdForRender = cache(() => randomUUID());
const timingContext = new AsyncLocalStorage<ServerTimingContext>();
export const serverTimingEnabled = process.env.NODE_ENV === "production"
  ? process.env.SERVER_TIMING_ENABLED !== "false"
  : process.env.SERVER_TIMING_ENABLED === "true";

function getDatabaseRegion() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;

  try {
    const hostname = new URL(connectionString).hostname;
    return hostname.match(/\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function getServerTimingContext() {
  return timingContext.getStore();
}

export function getServerTimingRequestId() {
  return timingContext.getStore()?.requestId ?? requestIdForRender();
}

function emitTiming(context: ServerTimingContext, operation: string, durationMs: number) {
  console.info(JSON.stringify({
    event: "server_timing",
    requestId: context.requestId,
    route: context.route,
    operation,
    durationMs: Number(durationMs.toFixed(2)),
    runtimeRegion: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? null,
    databaseRegion: getDatabaseRegion(),
  }));
}

export function logServerTiming(route: string, operation: string, durationMs: number) {
  if (!serverTimingEnabled) return;
  emitTiming({ requestId: requestIdForRender(), route }, operation, durationMs);
}

export async function measureServerOperation<T>(
  route: string,
  operation: string,
  callback: () => T | Promise<T>,
): Promise<T> {
  const context = { requestId: requestIdForRender(), route };
  const startedAt = performance.now();

  return timingContext.run(context, async () => {
    try {
      return await callback();
    } finally {
      logServerTiming(route, operation, performance.now() - startedAt);
    }
  });
}

export function logPrismaQueryTiming(durationMs: number) {
  if (!serverTimingEnabled) return;
  const context = getServerTimingContext();
  if (!context) return;

  console.info(JSON.stringify({
    event: "prisma_query_timing",
    requestId: context.requestId,
    route: context.route,
    durationMs,
    runtimeRegion: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? null,
    databaseRegion: getDatabaseRegion(),
  }));
}
