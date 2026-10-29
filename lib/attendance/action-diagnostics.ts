const maximumMessageLength = 2000;
const maximumStackLength = 8000;

function redactSensitiveText(value: string) {
  return value
    .replace(/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?):\/\/[^\s"'`<>]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(
      /\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|authorization|cookie))\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      (_match, key: string) => `${key}=[REDACTED]`,
    );
}

function prismaErrorCode(error: Error) {
  const candidate = error as Error & { code?: unknown; errorCode?: unknown };
  const code = candidate.code ?? candidate.errorCode;
  return typeof code === "string" && /^P\d{4}$/.test(code) ? code : undefined;
}

export function attendanceActionErrorDetails(error: unknown) {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: "A non-Error value was thrown." };
  }

  const stackFrames = error.stack?.split("\n").slice(1).join("\n");
  const code = prismaErrorCode(error);
  return {
    name: redactSensitiveText(error.name || "Error").slice(0, 100),
    message: redactSensitiveText(error.message).slice(0, maximumMessageLength),
    ...(code ? { code } : {}),
    ...(stackFrames
      ? { stack: redactSensitiveText(stackFrames).slice(0, maximumStackLength) }
      : {}),
  };
}
