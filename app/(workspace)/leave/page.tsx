import Link from "next/link";
import { Plus } from "lucide-react";
import { LeaveRequestHistory } from "@/components/leave-request-history";
import { requirePageUser } from "@/lib/auth/session";
import { listOwnLeaveRequests } from "@/lib/leave/request-service";
import { redirect } from "next/navigation";

type SearchParams = { success?: string; page?: string };

export default async function LeaveRequestsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const actor = await requirePageUser();
  if (actor.role === "ADMIN") redirect("/admin");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const result = await listOwnLeaveRequests(actor, { page });
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[var(--blue)]">Personal records</p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Leave requests</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">{result.total} request{result.total === 1 ? "" : "s"}</p>
        </div>
        <Link href="/leave/new" className="inline-flex h-11 items-center gap-2 rounded-lg bg-[var(--action)] px-4 text-sm font-semibold text-white hover:bg-[var(--action-hover)]">
          <Plus size={17} aria-hidden="true" /> Apply for Leave
        </Link>
      </div>
      <LeaveRequestHistory requests={result.items} success={params.success} page={result.page} pageCount={result.pageCount} timeZone={actor.timeZone} />
    </div>
  );
}
