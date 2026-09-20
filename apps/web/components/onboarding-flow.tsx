"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The three-step first-run flow:
 *   1. create an API key (plaintext shown once)
 *   2. point any OpenAI SDK at the proxy and send a test request
 *   3. see waste appear (in dev, runs the classifier on demand)
 */
export function OnboardingFlow({
  proxyBaseUrl,
  authMode,
  canWrite,
  activeKeyCount,
  initialRequestCount,
  initialWasteEventCount,
}: {
  proxyBaseUrl: string;
  authMode: "dev" | "deskid";
  canWrite: boolean;
  activeKeyCount: number;
  initialRequestCount: number;
  initialWasteEventCount: number;
}) {
  const router = useRouter();
  const [keyName, setKeyName] = useState("first-key");
  const [created, setCreated] = useState<{ plaintext: string } | null>(null);
  const [pastedKey, setPastedKey] = useState("");
  const [requestCount, setRequestCount] = useState(initialRequestCount);
  const [wasteCount, setWasteCount] = useState(initialWasteEventCount);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasKey = activeKeyCount > 0 || created !== null;
  const hasTraffic = requestCount > 0;
  const step = !hasKey ? 1 : !hasTraffic ? 2 : 3;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  };

  const createKey = () =>
    run("create", async () => {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: keyName.trim() || "first-key" }),
      });
      if (!res.ok) throw new Error("Couldn't create the key.");
      const body = (await res.json()) as { plaintext: string };
      setCreated({ plaintext: body.plaintext });
      setPastedKey(body.plaintext);
    });

  const sendTest = () =>
    run("test", async () => {
      const res = await fetch("/api/onboarding/test-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: pastedKey.trim() }),
      });
      if (!res.ok) throw new Error("The test request failed. Check the key.");
      const body = (await res.json()) as { ok: boolean };
      if (!body.ok) throw new Error("The proxy didn't accept the request.");
      setRequestCount((n) => n + 1);
    });

  const runClassifier = () =>
    run("classify", async () => {
      const res = await fetch("/api/onboarding/classify", { method: "POST" });
      if (!res.ok) throw new Error("The classifier run failed.");
      const body = (await res.json()) as { wasteEvents: number };
      setWasteCount((n) => n + Math.max(0, body.wasteEvents));
      router.refresh();
    });

  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});

  return (
    <div className="mt-10 space-y-6">
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-accent bg-surface px-4 py-3 text-small text-accent"
        >
          {error}
        </p>
      ) : null}

      {/* Step 1. */}
      <section
        className={`max-w-xl rounded-lg border bg-surface p-6 ${
          step === 1 ? "border-primary" : "border-border"
        }`}
      >
        <p className="text-micro font-medium tracking-wide text-muted uppercase">
          Step 1
        </p>
        <h2 className="mt-1 text-body font-semibold">Create your first key.</h2>
        {created ? (
          <div className="mt-4">
            <p className="text-small font-medium text-accent">
              Shown once. Copy it now — we only store the hash.
            </p>
            <code className="mt-2 block overflow-x-auto rounded-md border border-border bg-bg px-3 py-2 text-micro">
              {created.plaintext}
            </code>
            <button
              type="button"
              onClick={() => copy(created.plaintext)}
              className="mt-2 text-small text-primary hover:underline"
            >
              Copy
            </button>
          </div>
        ) : (
          <div className="mt-4 flex gap-2">
            <input
              type="text"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              disabled={!canWrite}
              className="w-56 rounded-md border border-border bg-surface px-3 py-2 text-small shadow-(--shadow-interactive) focus:border-primary focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              disabled={!canWrite || busy !== null}
              onClick={() => void createKey()}
              className="rounded-md bg-primary px-4 py-2 text-small font-medium text-primary-ink shadow-(--shadow-interactive) hover:opacity-90 disabled:opacity-50"
            >
              {busy === "create" ? "Creating…" : "Create key"}
            </button>
          </div>
        )}
      </section>

      {/* Step 2. */}
      <section
        className={`max-w-xl rounded-lg border bg-surface p-6 sm:ml-10 ${
          step === 2 ? "border-primary" : "border-border"
        }`}
      >
        <p className="text-micro font-medium tracking-wide text-muted uppercase">
          Step 2
        </p>
        <h2 className="mt-1 text-body font-semibold">
          Point your SDK at the proxy.
        </h2>
        <p className="mt-2 text-small text-muted">
          One line changes: the base URL. Everything else stays.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-bg p-3 text-micro whitespace-pre-wrap">
{`from openai import OpenAI

client = OpenAI(
    base_url="${proxyBaseUrl}/v1",
    api_key="<your vy_live_ key>",  # sent as X-Vyaya-Key
)`}
        </pre>
        <button
          type="button"
          onClick={() => copy(`base_url="${proxyBaseUrl}/v1"`)}
          className="mt-2 text-small text-primary hover:underline"
        >
          Copy base URL
        </button>
        <div className="mt-4 border-t border-border pt-4">
          <p className="text-small text-muted">
            Or prove it works right now: paste the key and we send one real
            request through the proxy for you.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              type="password"
              value={pastedKey}
              onChange={(e) => setPastedKey(e.target.value)}
              placeholder="vy_live_…"
              className="w-72 rounded-md border border-border bg-surface px-3 py-2 text-small shadow-(--shadow-interactive) focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              disabled={busy !== null || pastedKey.trim() === ""}
              onClick={() => void sendTest()}
              className="rounded-md bg-primary px-4 py-2 text-small font-medium text-primary-ink shadow-(--shadow-interactive) hover:opacity-90 disabled:opacity-50"
            >
              {busy === "test" ? "Sending…" : "Send test request"}
            </button>
          </div>
          {hasTraffic ? (
            <p className="mt-2 text-small text-primary">
              Traffic received: {requestCount.toLocaleString("en-US")}{" "}
              request{requestCount === 1 ? "" : "s"} through the proxy.
            </p>
          ) : null}
        </div>
      </section>

      {/* Step 3. */}
      <section
        className={`max-w-xl rounded-lg border bg-surface p-6 sm:ml-20 ${
          step === 3 ? "border-primary" : "border-border"
        }`}
      >
        <p className="text-micro font-medium tracking-wide text-muted uppercase">
          Step 3
        </p>
        <h2 className="mt-1 text-body font-semibold">See your first waste.</h2>
        {wasteCount > 0 ? (
          <p className="mt-2 text-small text-muted">
            Done: {wasteCount.toLocaleString("en-US")} waste event
            {wasteCount === 1 ? "" : "s"} classified. The dashboard has the
            dollar figures.
          </p>
        ) : authMode === "dev" ? (
          <div className="mt-2">
            <p className="text-small text-muted">
              The classifier normally runs nightly. In dev you can run it now.
            </p>
            <button
              type="button"
              disabled={!hasTraffic || busy !== null}
              onClick={() => void runClassifier()}
              className="mt-3 rounded-md bg-primary px-4 py-2 text-small font-medium text-primary-ink shadow-(--shadow-interactive) hover:opacity-90 disabled:opacity-50"
            >
              {busy === "classify" ? "Running…" : "Run the classifier now"}
            </button>
          </div>
        ) : (
          <p className="mt-2 text-small text-muted">
            The classifier runs nightly. Your first waste report lands
            tomorrow morning.
          </p>
        )}
      </section>
    </div>
  );
}
