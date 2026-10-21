import * as React from "react";
import {
  attendanceLocationPunchLabel,
  hasPoorGpsAccuracy,
} from "@/lib/attendance/location-presentation";
import type { AttendancePunchDirection } from "@/lib/attendance/location-presentation";
import type { WorkMode } from "@prisma/client";

export function AttendanceLocationPunchLabel({
  direction,
  workMode,
}: {
  direction: AttendancePunchDirection;
  workMode: WorkMode | null;
}) {
  return (
    <span className={`rounded-sm px-2 py-1 text-xs font-semibold ${direction === "IN" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
      {attendanceLocationPunchLabel(direction, workMode)}
    </span>
  );
}

export function AttendanceLocationAccuracy({ accuracy }: { accuracy: number | null }) {
  if (accuracy === null) return "—";

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>{accuracy} m</span>
      {hasPoorGpsAccuracy(accuracy) && (
        <span className="rounded-sm bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">
          Low accuracy
        </span>
      )}
    </span>
  );
}
