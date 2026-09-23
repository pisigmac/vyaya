"use client";

import { useState } from "react";
import type { ApiKeyView } from "@/lib/bff/keys";

/**
 * Keys table with create / revoke / rotate. New plaintext (create, rotate)
 * is shown once in the page and never stored anywhere.
 */
export function KeysManager({
  initialKeys,
  readOnly,
}: {
  initialKeys: ApiKeyView[];
  readOnly: boolean;
}) {
  const [keys, setKeys] = useState(initialKeys);
  const [newName, setNewName] = useState("");
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const res = await fetch("/api/keys");
    if (res.ok) {
      const body = (await res.json()) as { keys: ApiKeyView[] };
      setKeys(body.keys);
    }
  };

  const call = async (fn: () => Promise<Response>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string }).error ?? "request failed");
      return body as { plaintext?: string };
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const body = await call(() =>
      fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName || "default" }),
      }),
    );
    if (body?.plaintext) setFreshKey(body.plaintext);
    await refresh();
  };

  const revoke = async (id: string) => {
    await call(() => fetch(`/api/keys/${id}/revoke`, { method: "POST" }));
    await refresh();
  };

  const rotate = async (id: string) => {
    const body = await call(() =>
      fetch(`/api/keys/${id}/rotate`, { method: "POST" }),
    );
    if (body?.plaintext) setFreshKey(body.plaintext);
    await refresh();
  };

  return (
    <div className="mt-4">
      {freshKey ? (
        <div className="mb-4 max-w-2xl rounded-lg border border-accent bg-surface p-4">
          <p className="text-small font-medium text-accent">
            New key, shown once. Copy it now.
          </p>
          <code className="mt-2 block overflow-x-auto rounded-md border border-border bg-bg p-3 text-small">
            {freshKey}
          </code>
        </div>
      ) : null}

      {!readOnly ? (
        <div className="mb-4 flex items-center gap-3">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Key name"
            aria-label="New key name"
            className="w-48 rounded-md border border-border bg-surface px-3 py-2 text-small"
          />
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy}
            className="rounded-md bg-primary px-4 py-2 text-small font-medium text-primary-ink shadow-(--shadow-interactive) hover:opacity-90 disabled:opacity-50"
          >
            Create key
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mb-4 text-small text-accent">
          {error}
        </p>
      ) : null}

      <table className="w-full max-w-3xl text-left text-small">
        <thead>
          <tr className="border-b border-border text-micro tracking-wide text-muted uppercase">
            <th className="py-2 pr-4 font-medium">Name</th>
            <th className="py-2 pr-4 font-medium">Key</th>
            <th className="py-2 pr-4 font-medium">Created</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            {!readOnly ? <th className="py-2 font-medium">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id} className="border-b border-border last:border-0">
              <td className="py-2.5 pr-4 font-medium">{key.name}</td>
              <td className="py-2.5 pr-4 text-muted">vy_live_…{key.last4}</td>
              <td className="py-2.5 pr-4 text-muted">
                {new Date(key.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </td>
              <td className="py-2.5 pr-4">
                {key.revokedAt ? (
                  <span className="text-muted">Revoked</span>
                ) : (
                  <span className="text-primary">Active</span>
                )}
              </td>
              {!readOnly ? (
                <td className="py-2.5">
                  {!key.revokedAt ? (
                    <span className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void rotate(key.id)}
                        disabled={busy}
                        className="rounded-md border border-border bg-surface px-3 py-1 text-micro shadow-(--shadow-interactive) hover:border-muted disabled:opacity-50"
                      >
                        Rotate key
                      </button>
                      <button
                        type="button"
                        onClick={() => void revoke(key.id)}
                        disabled={busy}
                        className="rounded-md border border-accent bg-surface px-3 py-1 text-micro text-accent shadow-(--shadow-interactive) hover:opacity-80 disabled:opacity-50"
                      >
                        Revoke key
                      </button>
                    </span>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
          {keys.length === 0 ? (
            <tr>
              <td colSpan={5} className="py-4 text-muted">
                No keys yet. Create one and the proxy starts accepting your
                traffic.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
