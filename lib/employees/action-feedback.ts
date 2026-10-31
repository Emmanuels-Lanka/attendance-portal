import { revalidateAfterCommit } from "@/lib/diagnostics/server-action";

export function employeeDetailRedirect(employeeId: string, refreshSucceeded: boolean) {
  const path = `/admin/employees/${encodeURIComponent(employeeId)}`;
  return refreshSucceeded ? path : `${path}?refresh=failed`;
}

export function employeeMutationRedirect(
  employeeId: string,
  revalidate: () => void,
  reportError: (error: unknown) => void,
) {
  const refreshed = revalidateAfterCommit(revalidate, reportError);
  return employeeDetailRedirect(employeeId, refreshed);
}
