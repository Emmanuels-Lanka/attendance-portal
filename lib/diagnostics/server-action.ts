import "server-only";

import { getServerTimingContext, getServerTimingRequestId } from "@/lib/diagnostics/server-timing";

function getPrismaDiagnostics(error: unknown) {
  if (!error || typeof error !== "object") return {};
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" && /^P\d{4}$/.test(record.code)
    ? record.code
    : undefined;
  const meta = record.meta && typeof record.meta === "object"
    ? record.meta as Record<string, unknown>
    : undefined;
  const modelName = typeof meta?.modelName === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(meta.modelName)
    ? meta.modelName
    : undefined;
  const constraint = code === "P2004"
    && typeof meta?.constraint === "string"
    && /^[A-Za-z][A-Za-z0-9_]{0,119}$/.test(meta.constraint)
    ? meta.constraint
    : undefined;
  return {
    ...(code ? { prismaCode: code } : {}),
    ...(modelName ? { prismaModel: modelName } : {}),
    ...(constraint ? { prismaConstraint: constraint } : {}),
  };
}

function getErrorName(error: unknown) {
  if (!(error instanceof Error)) return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_$]{0,79}$/.test(error.name) ? error.name : "Error";
}

export function logServerActionError(operation: string, error: unknown, route?: string) {
  const context = getServerTimingContext();
  const prismaDiagnostics = getPrismaDiagnostics(error);
  console.error(JSON.stringify({
    event: "server_action_error",
    requestId: getServerTimingRequestId(),
    route: route ?? context?.route ?? "unknown",
    operation,
    errorName: getErrorName(error),
    ...prismaDiagnostics,
  }));
}

export function revalidateAfterCommit(
  revalidate: () => void,
  reportError: (error: unknown) => void,
) {
  try {
    revalidate();
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

export function appendRefreshWarning(message: string, refreshed: boolean) {
  return refreshed
    ? message
    : `${message} The change was saved, but the page could not refresh. Reload to see the latest status.`;
}
