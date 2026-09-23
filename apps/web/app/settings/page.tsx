import { redirect } from "next/navigation";
import { listApiKeys } from "@/lib/bff/keys";
import { listReports } from "@/lib/bff/reports";
import { getWorkspaceSettings } from "@/lib/bff/settings";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/http";
import { KeysManager } from "@/components/keys-manager";
import { WorkspaceSettingsForm } from "@/components/workspace-settings-form";
import { formatPercent, formatUsd } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession().catch(() => null);
  if (!session) redirect("/login?next=/settings");

  const db = getDb().db;
  const [keys, settings, reports] = await Promise.all([
    listApiKeys(db, session),
    getWorkspaceSettings(db, session),
    listReports(db, session),
  ]);
  const readOnly = session.role === "viewer";

  return (
    <div className="pt-8">
      <h1 className="text-title font-semibold">Settings.</h1>
      {readOnly ? (
        <p className="mt-2 text-small text-muted">
          You're signed in as a viewer. Everything here is read-only.
        </p>
      ) : null}

      <section className="mt-8">
        <h2 className="text-body font-semibold">API keys.</h2>
        <p className="mt-1 text-small text-muted">
          Keys authenticate the proxy. We store argon2id hashes — the
          plaintext appears once, at creation.
        </p>
        <KeysManager initialKeys={keys} readOnly={readOnly} />
      </section>

      <section className="mt-12 max-w-xl">
        <h2 className="text-body font-semibold">Workspace.</h2>
        <p className="mt-1 text-small text-muted">
          {settings.name} · {settings.slug}
        </p>
        <WorkspaceSettingsForm initial={settings} readOnly={readOnly} />
      </section>

      <section className="mt-12">
        <h2 className="text-body font-semibold">Weekly reports.</h2>
        {reports.length === 0 ? (
          <p className="mt-2 text-small text-muted">
            No reports yet. The worker writes one after each completed week.
          </p>
        ) : (
          <table className="mt-4 w-full max-w-3xl text-left text-small">
            <thead>
              <tr className="border-b border-border text-micro tracking-wide text-muted uppercase">
                <th className="py-2 pr-4 font-medium">Week</th>
                <th className="py-2 pr-4 font-medium">Spend</th>
                <th className="py-2 pr-4 font-medium">Wasted</th>
                <th className="py-2 pr-4 font-medium">Rate</th>
                <th className="py-2 font-medium">PDF</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="py-2.5 pr-4">
                    {r.weekStart} to {r.weekEnd}
                  </td>
                  <td className="py-2.5 pr-4">{formatUsd(r.totalSpendUsd)}</td>
                  <td className="py-2.5 pr-4 text-accent">
                    {formatUsd(r.dollarsWasted)}
                  </td>
                  <td className="py-2.5 pr-4">{formatPercent(r.wasteRate)}</td>
                  <td className="py-2.5">
                    {r.hasPdf ? (
                      <a
                        href={`/api/reports/${r.id}`}
                        className="text-primary hover:underline"
                      >
                        Download
                      </a>
                    ) : (
                      <span className="text-muted">None</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
