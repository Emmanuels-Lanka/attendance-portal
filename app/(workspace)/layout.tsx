import { AppShell } from "@/components/app-shell";
import { requirePageUser } from "@/lib/auth/session";
import { getCompanyName } from "@/lib/attendance/settings";

export default async function WorkspaceLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await requirePageUser();
  const companyName = await getCompanyName();
  return <AppShell user={user} companyName={companyName}>{children}</AppShell>;
}