"use client";

import { useState } from "react";
import type { WorkspaceSettings } from "@/lib/bff/settings";

/**
 * Workspace settings: LOG_BODIES opt-in, feature-tag allowlist, report
 * recipient. One save button, honest copy about what body logging means.
 */
export function WorkspaceSettingsForm({
  initial,
  readOnly,
}: {
  initial: WorkspaceSettings;
  readOnly: boolean;
}) {
  const [logBodies, setLogBodies] = useState(initial.logBodiesEnabled);
  const [reportEmail, setReportEmail] = useState(initial.reportEmail ?? "");
  const [tagsText, setTagsText] = useState(initial.featureTags.join(", "));
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const featureTags = tagsText
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    try {
      const res = await fetch("/api/settings/workspace", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          logBodiesEnabled: logBodies,
          reportEmail: reportEmail.trim() === "" ? "" : reportEmail.trim(),
          featureTags,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "save failed");
      setMessage("Saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 space-y-6">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={logBodies}
          onChange={(e) => setLogBodies(e.target.checked)}
          disabled={readOnly}
          className="mt-1"
        />
        <span>
          <span className="block text-small font-medium">
            Log prompt and response bodies
          </span>
          <span className="block text-small text-muted">
            Off by default — we log metadata only. Turn it on and bodies are
            encrypted with your workspace key and deleted after 7 days.
          </span>
        </span>
      </label>

      <label className="block">
        <span className="block text-small font-medium">
          Report email recipient
        </span>
        <span className="block text-small text-muted">
          Where the weekly waste report goes. Empty = every workspace member.
        </span>
        <input
          type="email"
          value={reportEmail}
          onChange={(e) => setReportEmail(e.target.value)}
          placeholder="you@company.com"
          disabled={readOnly}
          className="mt-1 w-full max-w-sm rounded-md border border-border bg-surface px-3 py-2 text-small"
        />
      </label>

      <label className="block">
        <span className="block text-small font-medium">
          Feature-tag allowlist
        </span>
        <span className="block text-small text-muted">
          Comma-separated. Empty = accept every X-Vyaya-Tag value.
        </span>
        <input
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="checkout, search, onboarding"
          disabled={readOnly}
          className="mt-1 w-full max-w-sm rounded-md border border-border bg-surface px-3 py-2 text-small"
        />
      </label>

      {!readOnly ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="rounded-md bg-primary px-4 py-2 text-small font-medium text-primary-ink shadow-(--shadow-interactive) hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving." : "Save settings"}
          </button>
          {message ? (
            <span className="text-small text-muted">{message}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
