import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { LeaveRequestForm } from "@/components/leave-request-form";
import { requirePageUser } from "@/lib/auth/session";
import { listEmployeeDocuments } from "@/lib/documents/service";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export default async function NewLeaveRequestPage() {
  const actor = await requirePageUser();
  if (actor.role === "ADMIN") redirect("/admin");
  const [leaveTypes, documents] = await Promise.all([
    prisma.leaveType.findMany({ select: { id: true, name: true, durationMode: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }),
    listEmployeeDocuments(actor),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/leave" className="inline-flex items-center gap-1 text-sm text-[var(--muted)]"><ChevronLeft size={16} aria-hidden="true" /> Leave requests</Link>
        <p className="mt-5 text-sm font-medium text-[var(--blue)]">Personal records</p>
        <h1 className="mt-1 text-2xl font-semibold">Apply for Leave</h1>
      </div>
      <LeaveRequestForm leaveTypes={leaveTypes} documents={documents} />
    </div>
  );
}
