import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { LeaveRequestFeedback } from "./leave-request-feedback";

type LeaveRequestItem = {
  id: string;
  startDate: Date;
  endDate: Date;
  status: "PENDING" | "APPROVED" | "REJECTED" | "RETURNED" | "CANCELLED";
  createdAt: Date;
  leaveType: { name: string };
};

const statusStyle: Record<LeaveRequestItem["status"], string> = {
  PENDING: "bg-amber-50 text-[var(--amber-ink)]",
  APPROVED: "bg-[var(--mint)] text-[var(--mint-ink)]",
  REJECTED: "bg-red-50 text-red-800",
  RETURNED: "bg-slate-100 text-slate-700",
  CANCELLED: "bg-zinc-100 text-zinc-600",
};

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function LeaveRequestHistory({
  requests,
  success,
  refreshStatus,
  page,
  pageCount,
  timeZone,
}: {
  requests: LeaveRequestItem[];
  success?: string;
  refreshStatus?: string;
  page: number;
  pageCount: number;
  timeZone: string;
}) {
  return (
    <div className="space-y-4">
      <LeaveRequestFeedback success={success} refreshStatus={refreshStatus} />
      <section className="overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-sm" aria-label="Leave request history">
        {requests.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
            <CalendarDays size={22} className="text-[var(--muted)]" aria-hidden="true" />
            <h2 className="mt-3 text-sm font-semibold">No Leave requests yet</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">Requests you submit will appear here.</p>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {requests.map((request) => (
              <li key={request.id} className="px-4 py-4 sm:px-5">
                <Link href={`/leave/${encodeURIComponent(request.id)}`} className="block rounded-sm focus-visible:outline">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold">{request.leaveType.name}</h2>
                    <span className={`rounded-sm px-2 py-1 text-xs font-medium ${statusStyle[request.status]}`}>{request.status.charAt(0) + request.status.slice(1).toLowerCase()}</span>
                  </div>
                  <p className="mt-2 text-sm text-[var(--muted)]">{dateOnly(request.startDate)} – {dateOnly(request.endDate)}</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">Submitted {request.createdAt.toLocaleDateString("en", { dateStyle: "medium", timeZone })}</p>
                  <span className="sr-only">View request details</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      {pageCount > 1 && (
        <nav aria-label="Leave request history pages" className="flex items-center justify-between">
          <p className="text-xs text-[var(--muted)]">Page {page} of {pageCount}</p>
          <div className="flex gap-2">
            {page > 1 && <Link href={`/leave?page=${page - 1}`} className="inline-flex h-9 items-center rounded-md border border-[var(--line)] px-3 text-sm">Previous</Link>}
            {page < pageCount && <Link href={`/leave?page=${page + 1}`} className="inline-flex h-9 items-center rounded-md border border-[var(--line)] px-3 text-sm">Next</Link>}
          </div>
        </nav>
      )}
    </div>
  );
}
