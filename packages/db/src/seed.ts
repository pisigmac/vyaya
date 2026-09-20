import { createHash } from "node:crypto";
import { loadDbEnv } from "@vyaya/config";
import { eq } from "drizzle-orm";
import {
  computeCost,
  EnvelopeCipher,
  type RequestStatus,
  type SchemaValidationResult,
} from "@vyaya/core";
import { generateApiKey, hashApiKey } from "./api-keys.js";
import { closeDb, createDb, withWorkspace } from "./client.js";
import * as schema from "./schema/index.js";
import type { NewRequestLogRow } from "./schema/index.js";

/**
 * Development seed: two workspaces, one demo user and one API key each,
 * and ~200 synthetic request_logs covering all five waste patterns plus
 * clean traffic, so the worker's detectors have something to find.
 *
 * Idempotent: all ids are deterministic and every insert is
 * ON CONFLICT DO NOTHING. Re-running never duplicates rows. API key
 * plaintext is printed only when the key row is first created.
 *
 * Encrypted demo bodies (needed for the context_amnesia detector) are
 * written only when MASTER_ENCRYPTION_KEY is set; otherwise the seed stays
 * metadata-only and says so.
 */

export const SEED_WORKSPACE_A_ID = "00000000-0000-4000-a000-00000000000a";
export const SEED_WORKSPACE_B_ID = "00000000-0000-4000-a000-00000000000b";
const SEED_USER_A_ID = "00000000-0000-4000-a000-0000000000a1";
const SEED_USER_B_ID = "00000000-0000-4000-a000-0000000000b1";
const SEED_API_KEY_A_ID = "00000000-0000-4000-a000-0000000000a2";
const SEED_API_KEY_B_ID = "00000000-0000-4000-a000-0000000000b2";

const ENDPOINT = "/v1/chat/completions";
const BODY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface SeedOptions {
  databaseUrl: string;
  /** Hex master key; when absent, body rows are skipped. */
  masterKeyHex?: string | null;
  /** Reference clock; defaults to Date.now(). */
  nowMs?: number;
  log?: (message: string) => void;
}

export interface SeedSummary {
  workspacesCreated: number;
  usersCreated: number;
  requestLogsInserted: number;
  requestBodiesInserted: number;
  /** Plaintext keys for NEWLY created keys only — print once, never store. */
  newApiKeys: { workspaceSlug: string; name: string; plaintext: string }[];
  bodiesSkippedNoMasterKey: boolean;
}

/** Deterministic PRNG so the traffic shape is stable across machines. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface LogSpec {
  suffix: string;
  occurredAt: Date;
  model: string;
  promptTokens: number;
  completionTokens: number;
  maxTokens: number | null;
  status: RequestStatus;
  schemaValidation: SchemaValidationResult;
  consumed: boolean;
  promptText?: string | null;
  sessionId?: string | null;
  featureTag?: string | null;
  retryAttempt?: number;
  retryOf?: string | null;
}

function toRow(workspaceSlug: string, workspaceId: string, spec: LogSpec): NewRequestLogRow {
  const requestId = `seed-req-${workspaceSlug}-${spec.suffix}`;
  const cost = computeCost({
    model: spec.model,
    promptTokens: spec.promptTokens,
    completionTokens: spec.completionTokens,
    at: spec.occurredAt,
  });
  return {
    requestId,
    workspaceId,
    occurredAt: spec.occurredAt,
    model: spec.model,
    endpoint: ENDPOINT,
    latencyMs: 150 + Math.floor((spec.promptTokens + spec.completionTokens) % 1200),
    promptTokens: spec.promptTokens,
    completionTokens: spec.completionTokens,
    maxTokens: spec.maxTokens,
    costUsd: cost.totalCostUsd,
    inputCostUsd: cost.inputCostUsd,
    outputCostUsd: cost.outputCostUsd,
    promptHash: sha256Hex(spec.promptText ?? `${workspaceId}:${requestId}`),
    sessionId: spec.sessionId ?? null,
    featureTag: spec.featureTag ?? null,
    status: spec.status,
    schemaValidation: spec.schemaValidation,
    responseConsumed: spec.consumed,
    retryAttempt: spec.retryAttempt ?? 0,
    retryOf: spec.retryOf ?? null,
  };
}

/** Shared background text for context_amnesia sessions: long, stable prefix. */
const AMNESIA_BACKGROUND = [
  "You are a support agent for a shipping platform.",
  "Company policy: refunds within thirty days require a receipt.",
  "Damaged items are replaced at no cost after photo review.",
  "Shipping is free over fifty dollars and takes three to five days.",
  "International orders may incur customs duties paid by the recipient.",
  "Support hours are Monday to Friday, nine to six Pacific time.",
  "Escalate billing disputes to the finance queue with a summary.",
  "Never promise delivery dates during carrier strike events.",
  "Always confirm the order id before making account changes.",
  "Tone: calm, direct, and specific. Apologize once, then act.",
].join(" ");

interface WorkspacePlan {
  id: string;
  slug: string;
  name: string;
  userId: string;
  userEmail: string;
  apiKeyId: string;
  apiKeyName: string;
  tags: string[];
  bodyLogging: boolean;
  logs: LogSpec[];
  /** session_id -> prompt text per turn (for body rows). */
  amnesiaSessions: { sessionId: string; prompts: string[] }[];
}

function buildPlan(opts: {
  id: string;
  slug: string;
  name: string;
  userId: string;
  userEmail: string;
  apiKeyId: string;
  apiKeyName: string;
  tags: string[];
  bodyLogging: boolean;
  nowMs: number;
  stormClusters: number;
  ghostCount: number;
  schemaFailCount: number;
  amnesiaSessionCount: number;
  overprovisionedCount: number;
  cleanCount: number;
  rand: () => number;
}): WorkspacePlan {
  const logs: LogSpec[] = [];
  const amnesiaSessions: WorkspacePlan["amnesiaSessions"] = [];
  const [tagA = "support-bot", tagB = "docs-qa", tagC = "code-review"] = opts.tags;
  const hours = (h: number) => new Date(opts.nowMs - h * 3_600_000);

  // 1. retry_storm: clusters of identical prompts; errors then a success.
  for (let c = 0; c < opts.stormClusters; c += 1) {
    const prompt = `Summarize ticket ${1000 + c}: customer cannot log in after password reset.`;
    const baseMs = opts.nowMs - (3 + c) * 3_600_000;
    const firstId = `seed-req-${opts.slug}-storm${c}-0`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const last = attempt === 3;
      logs.push({
        suffix: `storm${c}-${attempt}`,
        occurredAt: new Date(baseMs + attempt * 12_000),
        model: "gpt-4o-mini",
        promptTokens: 420,
        completionTokens: last ? 260 : 40,
        maxTokens: null,
        status: last ? "success" : "error",
        schemaValidation: "not_requested",
        consumed: last,
        promptText: prompt,
        featureTag: tagA,
        retryAttempt: attempt,
        retryOf: firstId,
      });
    }
  }

  // 2. ghost_output: successful, paid for, never consumed (hours old).
  for (let i = 0; i < opts.ghostCount; i += 1) {
    logs.push({
      suffix: `ghost${i}`,
      occurredAt: hours(4 + i),
      model: "gpt-4o",
      promptTokens: 800 + Math.floor(opts.rand() * 400),
      completionTokens: 600 + Math.floor(opts.rand() * 300),
      maxTokens: null,
      status: "success",
      schemaValidation: "not_requested",
      consumed: false,
      featureTag: tagB,
    });
  }

  // 3. schema_failure_burn: response_format requested, validation failed.
  for (let i = 0; i < opts.schemaFailCount; i += 1) {
    logs.push({
      suffix: `schemafail${i}`,
      occurredAt: hours(26 + i * 3),
      model: "gpt-4o-mini",
      promptTokens: 500 + Math.floor(opts.rand() * 200),
      completionTokens: 700 + Math.floor(opts.rand() * 400),
      maxTokens: null,
      status: "success",
      schemaValidation: "failed",
      consumed: true,
      featureTag: tagC,
    });
  }

  // 4. context_amnesia: same session repeats the background every turn.
  for (let s = 0; s < opts.amnesiaSessionCount; s += 1) {
    const sessionId = `seed-session-${opts.slug}-${s}`;
    const prompts: string[] = [];
    const startMs = opts.nowMs - (90 - s * 40) * 60_000;
    for (let turn = 0; turn < 6; turn += 1) {
      const prompt = `${AMNESIA_BACKGROUND} Customer question ${turn}: where is my order ${7000 + turn}?`;
      prompts.push(prompt);
      logs.push({
        suffix: `amnesia${s}-${turn}`,
        occurredAt: new Date(startMs + turn * 5 * 60_000),
        model: "gpt-4o",
        promptTokens: 640,
        completionTokens: 110 + Math.floor(opts.rand() * 40),
        maxTokens: null,
        status: "success",
        schemaValidation: "not_requested",
        consumed: true,
        promptText: prompt,
        sessionId,
        featureTag: tagA,
      });
    }
    amnesiaSessions.push({ sessionId, prompts });
  }

  // 5. overprovisioned_max_tokens: completion far below 30% of max_tokens.
  for (let i = 0; i < opts.overprovisionedCount; i += 1) {
    logs.push({
      suffix: `over${i}`,
      occurredAt: new Date(opts.nowMs - (i + 1) * 2 * 3_600_000),
      model: "gpt-4o-mini",
      promptTokens: 300 + Math.floor(opts.rand() * 100),
      completionTokens: 90 + Math.floor(opts.rand() * 90),
      maxTokens: 4096,
      status: "success",
      schemaValidation: "passed",
      consumed: true,
      featureTag: tagA,
    });
  }

  // 6. Clean traffic: consumed, schema passed. max_tokens null on purpose:
  // a healthy-ratio call would break the overprovisioned detector's
  // consecutive-run grouping for the same model.
  for (let i = 0; i < opts.cleanCount; i += 1) {
    logs.push({
      suffix: `clean${i}`,
      occurredAt: new Date(opts.nowMs - (i + 1) * 5 * 3_600_000),
      model: i % 2 === 0 ? "gpt-4o" : "gpt-4o-mini",
      promptTokens: 600 + Math.floor(opts.rand() * 500),
      completionTokens: 500 + Math.floor(opts.rand() * 400),
      maxTokens: null,
      status: "success",
      schemaValidation: i % 3 === 0 ? "passed" : "not_requested",
      consumed: true,
      featureTag: opts.tags[i % opts.tags.length] ?? null,
    });
  }

  return {
    id: opts.id,
    slug: opts.slug,
    name: opts.name,
    userId: opts.userId,
    userEmail: opts.userEmail,
    apiKeyId: opts.apiKeyId,
    apiKeyName: opts.apiKeyName,
    tags: opts.tags,
    bodyLogging: opts.bodyLogging,
    logs,
    amnesiaSessions,
  };
}

async function seedWorkspace(
  handle: ReturnType<typeof createDb>,
  plan: WorkspacePlan,
  cipher: EnvelopeCipher | null,
  nowMs: number,
  summary: SeedSummary,
): Promise<void> {
  await withWorkspace(handle, plan.id, async (tx) => {
    // Workspace bootstrap: the workspace_self policy permits the insert
    // because the GUC equals the new row's id.
    const createdWs = await tx
      .insert(schema.workspaces)
      .values({
        id: plan.id,
        name: plan.name,
        slug: plan.slug,
        logBodiesEnabled: plan.bodyLogging && cipher !== null,
      })
      .onConflictDoNothing()
      .returning({ id: schema.workspaces.id });
    summary.workspacesCreated += createdWs.length;

    const createdUsers = await tx
      .insert(schema.users)
      .values({
        id: plan.userId,
        workspaceId: plan.id,
        deskidSub: plan.userId,
        email: plan.userEmail,
        role: "admin",
      })
      .onConflictDoNothing()
      .returning({ id: schema.users.id });
    summary.usersCreated += createdUsers.length;

    // API key: only created (and printable) once.
    const existingKey = await tx
      .select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, plan.apiKeyId))
      .limit(1);
    const keyExists = existingKey.length > 0;
    if (!keyExists) {
      const key = generateApiKey();
      await tx.insert(schema.apiKeys).values({
        id: plan.apiKeyId,
        workspaceId: plan.id,
        createdByUserId: plan.userId,
        name: plan.apiKeyName,
        keyPrefix: key.prefix,
        keyHash: await hashApiKey(key.plaintext),
        last4: key.last4,
      });
      summary.newApiKeys.push({
        workspaceSlug: plan.slug,
        name: plan.apiKeyName,
        plaintext: key.plaintext,
      });
    }

    await tx
      .insert(schema.featureTagAllowlist)
      .values(plan.tags.map((tag) => ({ workspaceId: plan.id, tag })))
      .onConflictDoNothing();

    const rows = plan.logs.map((spec) => toRow(plan.slug, plan.id, spec));
    const insertedLogs = await tx
      .insert(schema.requestLogs)
      .values(rows)
      .onConflictDoNothing()
      .returning({ requestId: schema.requestLogs.requestId });
    summary.requestLogsInserted += insertedLogs.length;

    // Encrypted bodies for amnesia sessions (context_amnesia needs text).
    if (cipher !== null && plan.bodyLogging) {
      // One DEK per workspace, wrapped by the master key, stored on the
      // workspace row (created on first seed, reused after).
      const wsRows = await tx
        .select({ wrappedDek: schema.workspaces.wrappedDek })
        .from(schema.workspaces);
      const existingDek = wsRows[0]?.wrappedDek ?? null;
      const dek = existingDek ? cipher.unwrapDek(existingDek) : EnvelopeCipher.generateDek();
      if (!existingDek) {
        await tx
          .update(schema.workspaces)
          .set({ wrappedDek: cipher.wrapDek(dek) })
          .where(eq(schema.workspaces.id, plan.id));
      }
      const aad = Buffer.from(plan.id, "utf8");
      const bodyRows = plan.amnesiaSessions.flatMap((session) =>
        session.prompts.map((prompt, turn) => {
          const requestId = `seed-req-${plan.slug}-amnesia${plan.amnesiaSessions.indexOf(session)}-${turn}`;
          const responseText = `Your order ${7000 + turn} is on the way and arrives in three to five days.`;
          return {
            requestId,
            workspaceId: plan.id,
            promptEnvelope: cipher.encryptText(dek, prompt, aad),
            responseEnvelope: cipher.encryptText(dek, responseText, aad),
            promptBytes: Buffer.byteLength(prompt, "utf8"),
            responseBytes: Buffer.byteLength(responseText, "utf8"),
            expiresAt: new Date(nowMs + BODY_RETENTION_MS),
          };
        }),
      );
      if (bodyRows.length > 0) {
        const insertedBodies = await tx
          .insert(schema.requestBodies)
          .values(bodyRows)
          .onConflictDoNothing()
          .returning({ requestId: schema.requestBodies.requestId });
        summary.requestBodiesInserted += insertedBodies.length;
      }
    }
  });
}

export async function runSeed(options: SeedOptions): Promise<SeedSummary> {
  const nowMs = options.nowMs ?? Date.now();
  const log = options.log ?? (() => {});
  const cipher = options.masterKeyHex
    ? new EnvelopeCipher(EnvelopeCipher.masterKeyFromHex(options.masterKeyHex))
    : null;

  const summary: SeedSummary = {
    workspacesCreated: 0,
    usersCreated: 0,
    requestLogsInserted: 0,
    requestBodiesInserted: 0,
    newApiKeys: [],
    bodiesSkippedNoMasterKey: cipher === null,
  };

  const handle = createDb({ databaseUrl: options.databaseUrl, maxConnections: 2 });
  try {
    const planA = buildPlan({
      id: SEED_WORKSPACE_A_ID,
      slug: "acme",
      name: "Acme Support",
      userId: SEED_USER_A_ID,
      userEmail: "admin@acme.example",
      apiKeyId: SEED_API_KEY_A_ID,
      apiKeyName: "acme-production",
      tags: ["support-bot", "docs-qa", "code-review"],
      bodyLogging: true,
      nowMs,
      stormClusters: 3,
      ghostCount: 8,
      schemaFailCount: 6,
      amnesiaSessionCount: 2,
      overprovisionedCount: 55,
      cleanCount: 12,
      rand: mulberry32(42),
    });
    const planB = buildPlan({
      id: SEED_WORKSPACE_B_ID,
      slug: "beacon",
      name: "Beacon Analytics",
      userId: SEED_USER_B_ID,
      userEmail: "admin@beacon.example",
      apiKeyId: SEED_API_KEY_B_ID,
      apiKeyName: "beacon-production",
      tags: ["usage-reports", "alerts"],
      bodyLogging: false,
      nowMs,
      stormClusters: 2,
      ghostCount: 6,
      schemaFailCount: 5,
      amnesiaSessionCount: 0,
      overprovisionedCount: 55,
      cleanCount: 15,
      rand: mulberry32(1337),
    });
    await seedWorkspace(handle, planA, cipher, nowMs, summary);
    await seedWorkspace(handle, planB, cipher, nowMs, summary);
    log(
      `seed: ${summary.requestLogsInserted} request_logs, ` +
        `${summary.requestBodiesInserted} request_bodies, ` +
        `${summary.workspacesCreated} workspaces, ${summary.usersCreated} users, ` +
        `${summary.newApiKeys.length} new API keys`,
    );
    if (summary.bodiesSkippedNoMasterKey) {
      log("seed: MASTER_ENCRYPTION_KEY unset — skipped encrypted demo bodies");
    }
    return summary;
  } finally {
    await closeDb(handle);
  }
}

// CLI entry: node dist/seed.js
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const env = loadDbEnv();
  const summary = await runSeed({
    databaseUrl: env.databaseUrl,
    masterKeyHex: env.masterEncryptionKey,
    log: (m) => console.log(m),
  });
  for (const key of summary.newApiKeys) {
    console.log(
      `NEW API KEY (shown once, store it now) workspace=${key.workspaceSlug} name=${key.name}: ${key.plaintext}`,
    );
  }
  if (summary.newApiKeys.length === 0) {
    console.log("no new API keys (existing keys' plaintext is never re-shown)");
  }
}
