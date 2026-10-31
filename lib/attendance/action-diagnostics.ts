import { logServerActionError } from "@/lib/diagnostics/server-action";

export function logAttendanceActionError(operation: string, error: unknown, route = "/dashboard") {
  logServerActionError(operation, error, route);
}
