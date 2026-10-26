import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { ShiftForm } from "@/components/shift-form";
import { requirePagePermission } from "@/lib/auth/session";
import { getShift, ShiftNotFoundError } from "@/lib/shifts/service";

export default async function EditShiftPage({ params }: { params: Promise<{ shiftId: string }> }) {
  const admin = await requirePagePermission("shift:manage");
  const { shiftId } = await params;
  let shift;
  try {
    shift = await getShift(admin, shiftId);
  } catch (error) {
    if (!(error instanceof ShiftNotFoundError)) throw error;
    notFound();
  }
  return <div className="space-y-6"><div><Link href="/admin/shifts" className="inline-flex items-center gap-1 text-sm text-[var(--muted)]"><ChevronLeft size={16} aria-hidden="true" /> Shifts</Link><p className="mt-5 text-sm font-medium text-[var(--blue)]">Administration</p><h1 className="mt-1 text-2xl font-semibold">Edit shift</h1></div><ShiftForm id={shift.id} name={shift.name} startTime={shift.startTime?.toISOString().slice(11, 16)} endTime={shift.endTime?.toISOString().slice(11, 16)} breakStartTime={shift.breakStartTime?.toISOString().slice(11, 16)} breakDurationMinutes={shift.breakDurationMinutes} gracePeriodMinutes={shift.gracePeriodMinutes} lateThresholdMinutes={shift.lateThresholdMinutes} earlyDepartureThresholdMinutes={shift.earlyDepartureThresholdMinutes} minimumWorkingHours={shift.minimumWorkingHours?.toString() ?? null} overtimeEligible={shift.overtimeEligible} roundingRules={shift.roundingRules == null ? "" : JSON.stringify(shift.roundingRules, null, 2)} workingDays={shift.workingDays} /></div>;
}
