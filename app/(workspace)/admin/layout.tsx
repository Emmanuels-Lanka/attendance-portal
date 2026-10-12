import { redirect } from "next/navigation";
import { canReadScopedAttendance, hasPermission } from "@/lib/auth/permissions";
import { requirePageUser } from "@/lib/auth/session";

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const actor = await requirePageUser();
  if (
    actor.role !== "ADMIN"
    && !hasPermission(actor.role, "employee:manage")
    && !canReadScopedAttendance(actor.role)
  ) redirect("/dashboard");
  return children;
}