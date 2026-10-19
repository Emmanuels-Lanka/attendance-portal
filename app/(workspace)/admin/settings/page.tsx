import { readAppSettings } from "@/lib/attendance/qa-fixes";
import { prisma } from "@/lib/prisma";
import { requirePageAdmin } from "@/lib/auth/session";
import { saveSettingAction } from "./actions";

export default async function AdminSettingsPage({ searchParams }: { searchParams?: Promise<{ success?: string; error?: string }> }) {
  await requirePageAdmin();
  const params = (await searchParams) ?? {};
  const settings = await readAppSettings();
  const appSettings = await prisma.appSetting.findMany({ orderBy: [{ category: "asc" }, { key: "asc" }] });

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-[var(--blue)]">Administration</p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-[28px]">Settings</h1>
      </div>
      {params.success && <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{params.success}</p>}
      {params.error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{params.error}</p>}

      <section className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold">Organization settings</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">Office and WFH remain 08:30–17:30 in each employee&apos;s assigned timezone. The default timezone is an onboarding suggestion for accounts without a country-specific timezone rule.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <form action={saveSettingAction} className="space-y-3">
            <input type="hidden" name="category" value="GENERAL" />
            <input type="hidden" name="intent" value="save" />
            <label className="block text-sm font-medium text-[var(--muted)]">
              Company name
              <input type="text" name="key" value="companyName" readOnly className="mt-1 w-full rounded-md border border-[var(--line)] bg-slate-50 px-3 py-2 text-sm" />
            </label>
            <label className="block text-sm font-medium text-[var(--muted)]">
              Value
              <input type="text" name="value" defaultValue={settings.companyName} className="mt-1 w-full rounded-md border border-[var(--line)] px-3 py-2 text-sm" />
            </label>
            <div className="flex flex-wrap gap-2"><button type="submit" className="rounded-md bg-[var(--action)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--action-hover)]">Save</button><button type="reset" className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium">Cancel</button></div>
          </form>
          <form action={saveSettingAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="key" value="companyName" /><input type="hidden" name="intent" value="reset" />
            <label className="flex items-center gap-2 text-xs text-[var(--muted)]"><input type="checkbox" name="confirmReset" value="yes" required />Confirm reset of company name to Emmanuel&apos;s Lanka Pvt Ltd</label>
            <button type="submit" className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium">Reset default</button>
          </form>

          <form action={saveSettingAction} className="space-y-3">
            <input type="hidden" name="category" value="ATTENDANCE" />
            <input type="hidden" name="intent" value="save" />
            <label className="block text-sm font-medium text-[var(--muted)]">
              Default timezone for new accounts
              <input type="text" name="key" value="defaultTimeZone" readOnly className="mt-1 w-full rounded-md border border-[var(--line)] bg-slate-50 px-3 py-2 text-sm" />
            </label>
            <label className="block text-sm font-medium text-[var(--muted)]">
              Value
              <input type="text" name="value" defaultValue={settings.defaultTimeZone} className="mt-1 w-full rounded-md border border-[var(--line)] px-3 py-2 text-sm" />
            </label>
            <div className="flex flex-wrap gap-2"><button type="submit" className="rounded-md bg-[var(--action)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--action-hover)]">Save</button><button type="reset" className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium">Cancel</button></div>
          </form>
          <form action={saveSettingAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="key" value="defaultTimeZone" /><input type="hidden" name="intent" value="reset" />
            <label className="flex items-center gap-2 text-xs text-[var(--muted)]"><input type="checkbox" name="confirmReset" value="yes" required />Confirm reset of default timezone to Asia/Colombo</label>
            <button type="submit" className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-medium">Reset default</button>
          </form>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--line)] bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold">Stored settings</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-[var(--muted)]">
              <tr><th className="pb-2 pr-4 font-semibold">Key</th><th className="pb-2 pr-4 font-semibold">Value</th><th className="pb-2 pr-4 font-semibold">Category</th></tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {appSettings.map((row) => (
                <tr key={row.id}><td className="py-2 pr-4">{row.key}</td><td className="py-2 pr-4">{row.value}</td><td className="py-2 pr-4">{row.category}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
