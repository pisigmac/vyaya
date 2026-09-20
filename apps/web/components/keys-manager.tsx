"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ApiKeySummary } from "@/lib/bff/keys";
import { formatDateTime } from "@/lib/format";

/**
 * API key management: create, revoke, rotate. Plaintext of a new key is
 * shown exactly once in a dismissible callout; we never store it.
 */
export function KeysManager({
  initialKeys,
  readOnly,
}: {
  initialKeys: ApiKeySummary[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [keys, setKeys] = useState(initialKeys);
  const [newKeyName, setNewKeyName] = useState("");
  const [revealed, setRevealed] = useState<{ name: string; plaintext: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch {
      setError("That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const createKey = () =>
    run(async () => {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newKeyName.trim() || "default" }),
      });
      if (!res.ok) throw new Error();
      const body = (await res.json()) as {
        key: ApiKeySummary;
        plaintext: string;
      };
      setKeys((prev) => [body.key, ...prev]);
      setRevealed({ name: body.key.name, plaintext: body.plaintext });
      setNewKeyName("");
    });

  const revokeKey = (id: string) =>
    run(async () => {
      const res = await fetch(`/api/keys/${id}/revoke`, { method: "POST" });
      if (!res.ok) throw new Error();
      const body = (await res.json()) as { key: ApiKeySummary };
      setKeys((prev) => prev.map((k) => (k.id === id ? body.key : k)));
    });

  const rotateKey = (id: string) =>
    run(async () => {
      const res = await fetch(`/api/keys/${id}/rotate`, { method: "POST" });
      if (!res.ok) throw new Error();
      const body = (await res.json()) as {
        key: ApiKeySummary;
        plaintext: string;
        rotatedFromId: string;
      };
      setRevealed({ name: body.key.name, plaintext: body.plaintext });
      router.refresh();
      setKeys((prev) => [
        body.key,
        ...prev.map((k) =>
          k.id === body.rotatedFromId ? { ...k, revokedAt: new Date().toISOString() } : k,
        ),
      ]);
    });

  return (
    <div className="mt-4">
      {revealed ? (
        <div className="mb-4 rounded-md border border-accent bg-surface p-4">
          <p className="text-small font-medium text-accent">
            Shown once. Copy it now — we only store the hash.
          </p>
          <code className="mt-2 block overflow-x-auto rounded-md border border-border bg-bg px-3 py-2 text-micro">
            {revealed.plaintext}
          </code>
          <button
            type="button"
            className="mt-2 text-small text-muted hover:underline"
            onClick={() => setRevealed(null)}
          >
            I've copied it
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mb-3 text-small text-accent">
          {error}
        </p>
      ) : null}

      {!readOnly ? (
        <div className="mb-4 flex gap-2">
          <input
            type="text"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Key name (e.g. prod-backend)"
            className="w-64 rounded-md border border-border bg-surface px-3 py-2 text-small shadow-(--shadow-interactive) focus:border-primary focus:outline-none"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void createKey()}
            className="rounded-md bg-primary px-4 py-2 text-small font-medium text-primary-ink shadow-(--shadow-interactive) hover:opacity-90 disabled:opacity-50"
          >
            Create key
          </button>
        </div>
      ) : null}

      {keys.length === 0 ? (
        <p className="text-small text-muted">
          No keys yet. Create one to start sending traffic.
        </p>
      ) : (
        <table className="w-full text-left text-small">
          <thead>
            <tr className="border-b border-border text-micro tracking-wide text-muted uppercase">
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Key</th>
              <th className="py-2 pr-4 font-medium">Created</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              {readOnly ? null : <th className="py-2 font-medium">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id} className="border-b border-border last:border-0">
                <td className="py-2.5 pr-4 font-medium">{key.name}</td>
                <td className="py-2.5 pr-4">
                  <code className="text-micro text-muted">
                    {key.prefix}…{key.last4}
                  </code>
                </td>
                <td className="py-2.5 pr-4 text-muted">
                  {formatDateTime(key.createdAt)}
                </td>
                <td className="py-2.5 pr-4">
                  {key.revokedAt ? (
                    <span className="text-accent">revoked</span>
                  ) : (
                    <span className="text-primary">active</span>
                  )}
                </td>
                {readOnly ? null : (
                  <td className="py-2.5">
                    {key.revokedAt ? null : (
                      <span className="flex gap-3">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void rotateKey(key.id)}
                          className="text-primary hover:underline disabled:opacity-50"
                        >
                          Rotate
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void revokeKey(key.id)}
                          className="text-accent hover:underline disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      </span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
