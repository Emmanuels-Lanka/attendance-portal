"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { setEmployeeActiveAction } from "@/app/(workspace)/admin/employees/actions";
import { employeeStatusFormFeedback } from "@/lib/employees/status-form-feedback";
import type { EmployeeStatusActionState } from "@/lib/employees/status-form-feedback";

export function EmployeeStatusForm({ employeeId, isActive }: { employeeId: string; isActive: boolean }) {
  const action = setEmployeeActiveAction.bind(null, employeeId, !isActive);
  const [state, formAction, pending] = useActionState<EmployeeStatusActionState, FormData>(action, null);
  const router = useRouter();
  const [refreshTimedOutFor, setRefreshTimedOutFor] = useState<EmployeeStatusActionState>(null);
  const feedback = employeeStatusFormFeedback(isActive, pending, state, state !== null && refreshTimedOutFor === state);

  useEffect(() => {
    if (!state || !("success" in state)) return;
    router.refresh();
    if (state.isActive === isActive) return;
    const timeout = window.setTimeout(() => setRefreshTimedOutFor(state), 5000);
    return () => window.clearTimeout(timeout);
  }, [isActive, router, state]);

  return (
    <form
      action={formAction}
      aria-busy={pending}
      onSubmit={(event) => {
        if (!window.confirm(isActive ? "Deactivate this account? Sign-in will be disabled; attendance history and correction requests will be retained." : "Reactivate this employee account?")) {
          event.preventDefault();
        }
      }}
    >
      {feedback.error && <p role="alert" className="mb-2 text-sm text-red-700">{feedback.error}</p>}
      {feedback.success && <p role="status" className="mb-2 text-sm text-emerald-700">{feedback.success}</p>}
      <button type="submit" disabled={feedback.disabled} className={`h-10 rounded-md border px-3.5 text-sm font-medium disabled:opacity-60 ${isActive ? "border-red-200 text-red-700 hover:bg-red-50" : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"}`}>
        {feedback.buttonLabel}
      </button>
      <p className="mt-2 text-xs text-[var(--muted)]">Deactivation blocks sign-in. Records are retained; employee deletion is unavailable to protect attendance history.</p>
    </form>
  );
}