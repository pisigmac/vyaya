"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { WorkspaceSettings } from "@/lib/bff/settings";

/** Workspace name + body-logging opt-in (writes are viewer-blocked). */
export function WorkspaceSettingsForm({
  initial,
  readOnly,
}: {
  initial: WorkspaceSettings;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [logBodies, setLogBodies] = useState(initial.logBodiesEnabled);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/workspace", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, logBodiesEnabled: logBodies }),
      });
      if (!res.ok) throw new Error();
      setSaved(true);
      router.refresh();
    } catch {
      setError("Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <label className="block">
        <span className="text-small font-medium">Workspace name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={readOnly}
          className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-small shadow-(--shadow-interactive) focus:border-primary focus:outline-none disabled:opacity-50"
        />
      </label>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={logBodies}
          onChange={(e) => setLogBodies(e.target.checked)}
          disabled={readOnly}
          className="mt-1"
        />
        <span>
          <span className="text-small font-medium">
            Store request &amp; response bodies
          </span>
          <span className="mt-0.5 block text-small text-muted">
            Opt-in. Bodies are AES-256-GCM encrypted per workspace, kept for 7
            days, and visible only in this workspace. Metadata is logged
            either way.
          </span>
        </span>
      </label>
      {error ? (
        <p role="alert" className="text-small text-accent">
          {error}
        </p>
      ) : null}
      {saved ? <p className="text-small text-primary">Saved.</p> : null}
      {!readOnly ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded-md bg-primary px-4 py-2 text-small font-medium text-primary-ink shadow-(--shadow-interactive) hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      ) : null}
    </div>
  );
}
