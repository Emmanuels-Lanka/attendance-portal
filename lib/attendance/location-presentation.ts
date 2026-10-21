import type { WorkMode } from "@prisma/client";

export type AttendancePunchDirection = "IN" | "OUT";

// Report browser/device estimates above 100 m as low accuracy; retain the original value.
export const POOR_GPS_ACCURACY_THRESHOLD_METERS = 100;

export function attendanceLocationPunchLabel(
  direction: AttendancePunchDirection,
  workMode: WorkMode | null,
) {
  if (workMode !== "WFH") return direction;
  return direction === "IN" ? "WFH-IN" : "WFH-OUT";
}

export function hasPoorGpsAccuracy(accuracyMeters: number) {
  return accuracyMeters > POOR_GPS_ACCURACY_THRESHOLD_METERS;
}
