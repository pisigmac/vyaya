"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * First-run flow: create a key, swap base_url, send a test request, watch
 * the first waste event land. The plaintext key lives in this component's
 * state only — it's shown once and never sent anywhere except the test
 * request endpoint.
 */

interface Props {
  proxyBaseUrl: string;
  authMode: "dev" | "deskid";
  canWrite: boolean;
  activeKeyCount: number;
  initialRequestCount: number;
  initialWasteEventCount: number;
}

function tsSnippet(proxyBaseUrl: string): string {
  return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${proxyBaseUrl}/v1", // was https://api.openai.com/v1
  apiKey: "unused", // the proxy authenticates on X-Vyaya-Key
  defaultHeaders: { "X-Vyaya-Key": process.env.VYAYA_API_KEY! },
});`;
}

function pySnippet(proxyBaseUrl: string): string {
  return `import os
from openai import OpenAI

client = OpenAI(
    base_url="${proxyBaseUrl}/v1",  # was https://api.openai.com/v1
    api_key="unused",  # the proxy authenticates on X-Vyaya-Key
    default_headers={"X-Vyaya-Key": os.environ["VYAYA_API_KEY"]},
)`;
}

export function OnboardingFlow(props: Props) {
  const [keyName, setKeyName] = useState("default");
  const [plaintextKey, setPlaintextKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [pasteKey, setPasteKey] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const [wasteCount, setWasteCount] = useState(props.initialWasteEventCount);
  const [classifyMsg, setClassifyMsg] = useState<string | null>(null);
  const [classifying, setClassifying] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const createKey = async () => {
    setBusy(true);
    setKeyError(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: keyName }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "key creation failed");
      setPlaintextKey(body.plaintext as string);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "key creation failed");
    } finally {
      setBusy(false);
    }
  };

  const effectiveKey = plaintextKey ?? (pasteKey.trim() || null);

  const sendTest = async () => {
    if (!effectiveKey) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/onboarding/test-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: effectiveKey }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "test request failed");
      setTestResult(
        body.ok
          ? `Request landed (${body.latencyMs}ms). The proxy logged it — that's the whole point.`
          : `The proxy answered ${body.status}. Check the key and try again.`,
      );
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : "test failed");
    } finally {
      setTesting(false);
    }
  };

  const pollWaste = useCallback(async () => {
    try {
      const res = await fetch("/api/onboarding/workspace");
      if (res.ok) {
        const body = await res.json();
        setWasteCount(body.wasteEventCount as number);
      }
    } catch {
      // Polling is best-effort.
    }
  }, []);

  useEffect(() => {
    if (wasteCount > 0) return;
    pollRef.current = setInterval(() => void pollWaste(), 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [pollWaste, wasteCount]);

  const runClassifier = async () => {
    setClassifying(true);
    setClassifyMsg(null);
    try {
      const res = await fetch("/api/onboarding/classify", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "classifier run failed");
      setClassifyMsg(body.detail as string);
      await pollWaste();
    } catch (err) {
      setClassifyMsg(err instanceof Error ? err.message : "classifier failed");
    } finally {
      setClassifying(false);
    }
  };

  const found = wasteCount > 0;

  return (
    <div className="mt-10 max-w-2xl space-y-10">
      {/* Step 1: API key. */}
      <section>
        <h2 className="text-body font-semibold">1. Create your first key.</h2>
        {plaintextKey ? (
          <div className="mt-3 rounded-lg border border-accent bg-surface p-4">
            <p className="text-small font-medium text-accent">
              Shown once. Copy it now — we only store the hash.
            </p>
            <code className="mt-2 block overflow-x-auto rounded-md border border-border bg-bg p-3 text-small">
              {plaintextKey}
            </code>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-3">
            <input
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              aria-label="Key name"
              className="w-48 rounded-md border border-border bg-surface px-3 py-2 text-small"
              disabled={!props.canWrite}
            />
            <button
              type="button"
              onClick={() => void createKey()}
              disabled={busy || !props.canWrite}
              className="rounded-md bg-primary px-4 py-2 text-small font-medium text-primary-ink shadow-(--shadow-interactive) hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Creating." : "Create key"}
            </button>
            {props.activeKeyCount > 0 ? (
              <span className="text-small text-muted">
                You already have {props.activeKeyCount} active key
                {props.activeKeyCount === 1 ? "" : "s"}.
              </span>
            ) : null}
          </div>
        )}
        {keyError ? (
          <p role="alert" className="mt-2 text-small text-accent">
            {keyError}
          </p>
        ) : null}
        {!props.canWrite ? (
          <p className="mt-2 text-small text-muted">
            You're a viewer — ask an admin to create keys.
          </p>
        ) : null}
      </section>

      {/* Step 2: snippets. */}
      <section className="sm:ml-8">
        <h2 className="text-body font-semibold">2. Swap one line.</h2>
        <p className="mt-1 text-small text-muted">
          Point the OpenAI SDK at the proxy. Everything else stays put.
        </p>
        <div className="mt-3 space-y-3">
          <div>
            <p className="text-micro font-medium tracking-wide text-muted uppercase">
              TypeScript
            </p>
            <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-surface p-4 text-micro">
              {tsSnippet(props.proxyBaseUrl)}
            </pre>
          </div>
          <div>
            <p className="text-micro font-medium tracking-wide text-muted uppercase">
              Python
            </p>
            <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-surface p-4 text-micro">
              {pySnippet(props.proxyBaseUrl)}
            </pre>
          </div>
        </div>
      </section>

      {/* Step 3: test request. */}
      <section className="sm:ml-16">
        <h2 className="text-body font-semibold">3. Send your first request.</h2>
        {!plaintextKey ? (
          <input
            value={pasteKey}
            onChange={(e) => setPasteKey(e.target.value)}
            placeholder="Paste a vy_live_ key"
            aria-label="API key for the test request"
            className="mt-3 w-full max-w-md rounded-md border border-border bg-surface px-3 py-2 text-small"
          />
        ) : null}
        <div className="mt-3">
          <button
            type="button"
            onClick={() => void sendTest()}
            disabled={testing || !effectiveKey}
            className="rounded-md bg-primary px-4 py-2 text-small font-medium text-primary-ink shadow-(--shadow-interactive) hover:opacity-90 disabled:opacity-50"
          >
            {testing ? "Sending." : "Send test request"}
          </button>
        </div>
        {testResult ? (
          <p className="mt-2 text-small text-muted">{testResult}</p>
        ) : null}
      </section>

      {/* Step 4: first waste. */}
      <section>
        <h2 className="text-body font-semibold">4. Watch the waste show up.</h2>
        {found ? (
          <div className="mt-3 rounded-lg border border-primary bg-surface p-4">
            <p className="text-body font-semibold">First waste found.</p>
            <p className="mt-1 text-small text-muted">
              {wasteCount} event{wasteCount === 1 ? "" : "s"} on the board.
              The dashboard has the dollars and the fixes.
            </p>
            <Link
              href="/dashboard"
              className="mt-3 inline-block rounded-md bg-primary px-4 py-2 text-small font-medium text-primary-ink shadow-(--shadow-interactive) hover:opacity-90"
            >
              Open the dashboard
            </Link>
          </div>
        ) : (
          <div className="mt-3">
            <p className="text-small text-muted">
              The classifier runs nightly. This page checks every few seconds
              and lights up when the first event lands.
            </p>
            {props.authMode === "dev" ? (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => void runClassifier()}
                  disabled={classifying}
                  className="rounded-md border border-border bg-surface px-4 py-2 text-small font-medium text-ink shadow-(--shadow-interactive) hover:border-muted disabled:opacity-50"
                >
                  {classifying ? "Classifying." : "Run the classifier now"}
                </button>
                {classifyMsg ? (
                  <p className="mt-2 text-small text-muted">{classifyMsg}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
