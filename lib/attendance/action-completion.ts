type AttendanceActionSuccess = { ok: true; message: string };

export function completeAttendanceAction(
  calculationWarning: string | null,
  revalidate: () => void,
  reportRevalidationError: (error: unknown) => void,
): AttendanceActionSuccess {
  let revalidationFailed = false;
  try {
    revalidate();
  } catch (error) {
    reportRevalidationError(error);
    revalidationFailed = true;
  }

  const message = calculationWarning
    ? `Attendance updated. ${calculationWarning}`
    : "Attendance updated.";
  return {
    ok: true,
    message: revalidationFailed
      ? `${message} The page could not refresh. Reload to see the latest status.`
      : message,
  };
}
