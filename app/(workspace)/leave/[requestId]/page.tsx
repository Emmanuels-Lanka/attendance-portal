import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requirePageUser } from "@/lib/auth/session";
import { getOwnLeaveRequest, LeaveRequestNotFoundError } from "@/lib/leave/request-service";
import { redirect } from "next/navigation";

type RequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "RETURNED" | "CANCELLED";

const statusStyle: Record<RequestStatus, string> = {
  PENDING: "bg-amber-50 text-[var(--amber-ink)]",
  APPROVED: "bg-[var(--mint)] text-[var(--mint-ink)]",
  REJECTED: "bg-red-50 text-red-800",
  RETURNED: "bg-slate-100 text-slate-700",
  CANCELLED: "bg-zinc-100 text-zinc-600",
};

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function dateTime(date: Date, timeZone: string) {
  return date.toLocaleString("en", { dateStyle: "medium", timeStyle: "short", timeZone });
}

export default async function LeaveRequestDetailPage({ params }: { params: Promise<{ requestId: string }> }) {
  const actor = await requirePageUser();
  if (actor.role === "ADMIN") redirect("/admin");
  const { requestId } = await params;
  let request;
  try {
    request = await getOwnLeaveRequest(actor, requestId);
  } catch (error) {
    if (error instanceof LeaveRequestNotFoundError) notFound();
    throw error;
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/leave" className="inline-flex items-center gap-1 text-sm text-[var(--muted)]"><ChevronLeft size={16} aria-hidden="true" /> Leave requests</Link>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold sm:text-[28px]">Leave request</h1>
          <span className={`rounded-sm px-2 py-1 text-xs font-medium ${statusStyle[request.status]}`}>{request.status.charAt(0) + request.status.slice(1).toLowerCase()}</span>
        </div>
      </div>
      <section className="max-w-2xl rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm sm:p-7">
        <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          <div><dt className="text-xs font-medium text-[var(--muted)]">Leave Type</dt><dd className="mt-1 text-sm font-semibold">{request.leaveType.name}</dd></div>
          <div><dt className="text-xs font-medium text-[var(--muted)]">Dates</dt><dd className="mt-1 text-sm">{dateOnly(request.startDate)} – {dateOnly(request.endDate)}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs font-medium text-[var(--muted)]">Reason</dt><dd className="mt-1 whitespace-pre-wrap text-sm leading-6">{request.reason}</dd></div>
          {request.decisionReason && <div className="sm:col-span-2"><dt className="text-xs font-medium text-[var(--muted)]">Review note</dt><dd className="mt-1 whitespace-pre-wrap text-sm leading-6">{request.decisionReason}</dd></div>}
          <div><dt className="text-xs font-medium text-[var(--muted)]">Submitted</dt><dd className="mt-1 text-sm">{dateTime(request.createdAt, actor.timeZone)}</dd></div>
          <div><dt className="text-xs font-medium text-[var(--muted)]">Last updated</dt><dd className="mt-1 text-sm">{dateTime(request.updatedAt, actor.timeZone)}</dd></div>
          {request.reviewedAt && <div><dt className="text-xs font-medium text-[var(--muted)]">Reviewed</dt><dd className="mt-1 text-sm">{dateTime(request.reviewedAt, actor.timeZone)}</dd></div>}
          {request.attachmentDocumentId && <div><dt className="text-xs font-medium text-[var(--muted)]">Supporting document</dt><dd className="mt-1 text-sm">Attached</dd></div>}
        </dl>
      </section>
    </div>
  );
}
