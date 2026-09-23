import Link from "next/link";
import { redirect } from "next/navigation";
import { WASTE_TYPES } from "@vyaya/core";
import { WASTE_TYPE_BLURBS, WASTE_TYPE_LABELS } from "@/lib/format";
import { getSession } from "@/lib/http";

export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const session = await getSession().catch(() => null);
  if (session) redirect("/dashboard");

  return (
    <div className="pt-14">
      {/* Hero — deliberately off-center: text block sits left, proof lower right. */}
      <section className="max-w-2xl">
        <p className="text-small font-medium text-accent">
          A token-waste auditor for LLM APIs.
        </p>
        <h1 className="mt-3 text-hero font-semibold tracking-tight">
          See what your LLM spend is actually buying.
        </h1>
        <p className="mt-5 text-body text-muted">
          Your invoice says tokens. It doesn't say how many were wasted —
          retried, unread, or burned on output your schema rejected. Vyaya
          sits in front of your LLM traffic, counts the waste, and puts a
          dollar figure on every kind.
        </p>
        <div className="mt-8 flex items-center gap-4">
          <Link
            href="/login"
            className="rounded-md bg-primary px-5 py-2.5 text-body font-medium text-primary-ink shadow-(--shadow-interactive) hover:opacity-90"
          >
            Start auditing
          </Link>
          <span className="text-small text-muted">
            Five minutes. One line changed in your SDK.
          </span>
        </div>
      </section>

      {/* Problem — name the enemy. */}
      <section className="mt-24 grid gap-10 sm:grid-cols-2">
        <div>
          <h2 className="text-title font-semibold">The enemy is waste.</h2>
          <p className="mt-4 text-body text-muted">
            Not tokens. Not models. Waste — the spend that produces nothing.
            Teams guess at it from invoices and vibes, and the guess is always
            low.
          </p>
          <p className="mt-4 text-body text-muted">
            We take a stance: every wasted dollar is a bug, and every bug gets
            a fix. Vyaya shows both.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-6 sm:mt-10">
          <p className="text-micro font-medium tracking-wide text-muted uppercase">
            What the invoice hides
          </p>
          <p className="mt-3 text-body text-ink">
            A retry loop that fired four times before anyone noticed. A
            chatbot answer nobody read. A 4,096-token cap on a model that
            writes 60 words.
          </p>
          <p className="mt-3 text-body text-ink">
            That's not usage. That's waste with a receipt.
          </p>
        </div>
      </section>

      {/* Five waste types. Five cards in a 3-col grid — the grid breaks itself. */}
      <section className="mt-24">
        <h2 className="text-title font-semibold">
          Five kinds of waste. Each one detected, priced, and fixed.
        </h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {WASTE_TYPES.map((type, i) => (
            <div
              key={type}
              className={`rounded-lg border border-border bg-surface p-5 ${
                i === 3 ? "sm:translate-y-6" : ""
              }`}
            >
              <h3 className="text-body font-semibold">
                {WASTE_TYPE_LABELS[type]}
              </h3>
              <p className="mt-2 text-small text-muted">
                {WASTE_TYPE_BLURBS[type]}
              </p>
            </div>
          ))}
          <div className="rounded-lg border border-border bg-surface p-5">
            <h3 className="text-body font-semibold">Your bill, explained.</h3>
            <p className="mt-2 text-small text-muted">
              Every event carries evidence and a suggested fix — a code
              snippet, a config change, or a prompt fix you can paste today.
            </p>
          </div>
        </div>
      </section>

      {/* How it works — three steps, asymmetric. */}
      <section className="mt-28 grid gap-10 sm:grid-cols-[1fr_1.4fr]">
        <h2 className="text-title font-semibold">How it works.</h2>
        <ol className="space-y-6">
          <li className="border-l-2 border-primary pl-4">
            <p className="text-body font-semibold">Point your SDK at us.</p>
            <p className="mt-1 text-small text-muted">
              Swap one base_url. Your code doesn't change; your traffic flows
              through the Vyaya proxy and we log the metadata.
            </p>
          </li>
          <li className="border-l-2 border-primary pl-4 sm:ml-8">
            <p className="text-body font-semibold">We classify the waste.</p>
            <p className="mt-1 text-small text-muted">
              Five deterministic detectors score every request. No LLM judging
              your LLM — that would cost money too.
            </p>
          </li>
          <li className="border-l-2 border-primary pl-4 sm:ml-16">
            <p className="text-body font-semibold">You get dollars and fixes.</p>
            <p className="mt-1 text-small text-muted">
              A dashboard that ranks waste by cost, plus the exact change that
              kills it. Weekly report in your inbox.
            </p>
          </li>
        </ol>
      </section>

      {/* CTA. */}
      <section className="mt-28 max-w-xl">
        <h2 className="text-title font-semibold">
          Find your first wasted dollar today.
        </h2>
        <p className="mt-4 text-body text-muted">
          Sign in, get a key, swap one line. The dashboard does the rest.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-md bg-primary px-5 py-2.5 text-body font-medium text-primary-ink shadow-(--shadow-interactive) hover:opacity-90"
        >
          Start auditing
        </Link>
      </section>
    </div>
  );
}
