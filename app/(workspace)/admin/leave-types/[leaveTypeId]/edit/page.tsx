import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { LeaveTypeForm } from "@/components/leave-type-form";
import { requireAdmin } from "@/lib/auth/session";
import { getLeaveType, LeaveTypeNotFoundError } from "@/lib/leave/service";

export default async function EditLeaveTypePage({ params }: { params: Promise<{ leaveTypeId: string }> }) {
  const admin = await requireAdmin();
  const { leaveTypeId } = await params;
  let leaveType;
  try {
    leaveType = await getLeaveType(admin, leaveTypeId);
  } catch (error) {
    if (error instanceof LeaveTypeNotFoundError) notFound();
    throw error;
  }
  return <div className="space-y-6"><div><Link href="/admin/leave-types" className="inline-flex items-center gap-1 text-sm text-[var(--muted)]"><ChevronLeft size={16} aria-hidden="true" /> Leave Types</Link><p className="mt-5 text-sm font-medium text-[var(--blue)]">Administration</p><h1 className="mt-1 text-2xl font-semibold">Edit Leave Type</h1></div><LeaveTypeForm id={leaveType.id} name={leaveType.name} durationMode={leaveType.durationMode} /></div>;
}
