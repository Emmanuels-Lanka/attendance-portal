export type EmployeeStatusActionState =
  | { error: string }
  | { success: string; isActive: boolean }
  | null;

export function employeeStatusFormFeedback(
  isActive: boolean,
  pending: boolean,
  state: EmployeeStatusActionState,
  allowRetryDuringRefresh = false,
) {
  const waitingForRefresh = state !== null
    && "success" in state
    && state.isActive !== isActive;
  return {
    buttonLabel: pending
      ? "Saving..."
      : waitingForRefresh && !allowRetryDuringRefresh
        ? "Refreshing..."
        : isActive ? "Deactivate employee" : "Activate employee",
    disabled: pending || (waitingForRefresh && !allowRetryDuringRefresh),
    error: state && "error" in state ? state.error : null,
    success: state && "success" in state ? state.success : null,
  };
}
