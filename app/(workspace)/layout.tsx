import { AppShell } from "@/components/app-shell";
import { requirePageUser } from "@/lib/auth/session";
import { getCompanyName } from "@/lib/attendance/settings";
import { logServerTiming, measureServerOperation } from "@/lib/diagnostics/server-timing";

export default async function WorkspaceLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const startedAt = performance.now();
  try {
    const user = await measureServerOperation("workspace.layout", "workspace.auth_lookup", () => (
      requirePageUser("workspace.layout")
    ));
    const companyName = await measureServerOperation("workspace.layout", "workspace.company_name_lookup", getCompanyName);
    return <AppShell user={user} companyName={companyName}>{children}</AppShell>;
  } finally {
    logServerTiming("workspace.layout", "workspace.layout_total", performance.now() - startedAt);
  }
}