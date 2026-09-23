import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getBreakdown,
  getSummary,
  getTopFixes,
  getTrend,
  listWasteEvents,
} from "@/lib/bff/stats";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/http";
import {
  evidenceSummary,
  formatDateTime,
  formatPercent,
  formatUsd,
  WASTE_TYPE_LABELS,
} from "@/lib/format";
import { BreakdownPanel } from "@/components/breakdown-panel";
import { TrendChart } from "@/components/charts";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSession().catch(() => null);
  if (!session) redirect("/login?next=/dashboard");

  const db = getDb().db;
  const [summary, trend, breakdown, fixes, events] = await Promise.all([
    getSummary(db, session, 30),
    getTrend(db, session, 30),
    getBreakdown(db, session, "waste_type", 30),
    getTopFixes(db, session, 30),
    listWasteEvents(db, session, { page: 1, pageSize: 8, sort: "dollars" }),
  ]);

  const empty = summary.requestCount === 0;

  return (
    <div className="pt-8">
      <h1 className="text-title font-semibold">Your waste, priced.</h1>

      {empty ? (
        <div className="mt-8 max-w-lg rounded-lg border border-border bg-surface p-6">
          <p className="text-body font-semibold">No traffic yet.</p>
          <p className="mt-2 text-small text-muted">
            Nothing has flowed through the proxy, so there's nothing to
            audit. Finish onboarding and send your first request.
          </p>
          <Link
            href="/onboarding"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-small font-medium text-primary-ink shadow-(--shadow-interactive) hover:opacity-90"
          >
            Finish setup
          </Link>
        </div>
      ) : (
        <>
          {/* Hero: the one number that matters. */}
          <section className="mt-8 grid gap-4 sm:grid-cols-[2fr_1fr]">
            <div className="rounded-lg border border-border bg-surface p-6">
              <p className="text-small text-muted">
                Waste rate, last {summary.days} days
              </p>
              <p className="mt-2 text-hero font-semibold text-accent">
                {formatPercent(summary.wasteRate)}
              </p>
              <p className="mt-2 text-small text-muted">
                {formatUsd(summary.dollarsWasted)} wasted of{" "}
                {formatUsd(summary.totalSpendUsd)} spent across{" "}
                {summary.requestCount.toLocaleString("en-US")} requests.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-surface p-6 sm:mt-8">
              <p className="text-small text-muted">Waste events</p>
              <p className="mt-2 text-title font-semibold">
                {summary.wasteEventCount.toLocaleString("en-US")}
              </p>
              <p className="mt-2 text-small text-muted">
                Every one has evidence and a fix attached.
              </p>
            </div>
          </section>

          {/* Trend. */}
          <section className="mt-6 rounded-lg border border-border bg-surface p-6">
            <h2 className="text-body font-semibold">Spend vs. waste, daily.</h2>
            <div className="mt-4">
              <TrendChart points={trend} />
            </div>
          </section>

          {/* Breakdown + fixes, side by side but offset. */}
          <section className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-border bg-surface p-6">
              <h2 className="text-body font-semibold">Where the waste sits.</h2>
              <div className="mt-4">
                <BreakdownPanel initialSlices={breakdown} />
              </div>
            </div>
            <div className="rounded-lg border border-border bg-surface p-6 lg:mt-10">
              <h2 className="text-body font-semibold">
                Fix these three first.
              </h2>
              {fixes.length === 0 ? (
                <p className="mt-4 text-small text-muted">
                  No fixes to rank yet. Waste events bring their own
                  remediation.
                </p>
              ) : (
                <ol className="mt-4 space-y-3">
                  {fixes.map((fix, i) => (
                    <li
                      key={fix.wasteType}
                      className="rounded-md border border-border p-4"
                    >
                      <details>
                        <summary className="cursor-pointer">
                          <span className="text-small font-medium text-muted">
                            #{i + 1} · {WASTE_TYPE_LABELS[fix.wasteType]}
                          </span>
                          <span className="ml-2 text-small font-semibold text-accent">
                            {formatUsd(fix.projectedAnnualSavingsUsd)}/yr
                          </span>
                        </summary>
                        <p className="mt-2 text-small text-muted">
                          {formatUsd(fix.dollarsWasted30d)} wasted in 30 days
                          across {fix.eventCount} events. Projected annual
                          savings assumes the current rate holds.
                        </p>
                        <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-bg p-3 text-micro whitespace-pre-wrap">
                          {fix.suggestedFix}
                        </pre>
                      </details>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>

          {/* Top waste events. */}
          <section className="mt-6 rounded-lg border border-border bg-surface p-6">
            <h2 className="text-body font-semibold">Costliest waste events.</h2>
            {events.events.length === 0 ? (
              <p className="mt-4 text-small text-muted">
                No waste events yet. The classifier runs nightly — or trigger
                it from onboarding in dev.
              </p>
            ) : (
              <table className="mt-4 w-full text-left text-small">
                <thead>
                  <tr className="border-b border-border text-micro tracking-wide text-muted uppercase">
                    <th className="py-2 pr-4 font-medium">Type</th>
                    <th className="py-2 pr-4 font-medium">Wasted</th>
                    <th className="py-2 pr-4 font-medium">Why</th>
                    <th className="py-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {events.events.map((event) => (
                    <tr
                      key={event.id}
                      className="border-b border-border last:border-0"
                    >
                      <td className="py-2.5 pr-4 font-medium">
                        {WASTE_TYPE_LABELS[event.wasteType]}
                      </td>
                      <td className="py-2.5 pr-4 text-accent">
                        {formatUsd(event.dollarsWasted)}
                      </td>
                      <td className="py-2.5 pr-4 text-muted">
                        {evidenceSummary(event.wasteType, event.evidence)}
                      </td>
                      <td className="py-2.5 text-muted">
                        {formatDateTime(event.detectedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
