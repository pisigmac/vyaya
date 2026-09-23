import type { RequestLog, WasteEvent } from "../types.js";
import {
  byTimeThenId,
  makeWasteEvent,
  type DetectorContext,
  type WasteDetector,
} from "./interface.js";

/**
 * context_amnesia — the same session_id resends background/context content
 * across turns that a cache or system-prompt fix would eliminate.
 *
 * Rule: for consecutive turns of the same session, compute Jaccard
 * similarity over word-shingle sets of the prompt bodies. When similarity
 * >= contextAmnesiaJaccardThreshold and the estimated repeated input tokens
 * >= contextAmnesiaMinOverlapTokens, the repeated fraction of the later
 * turn's input cost is wasted. One event per session per run.
 *
 * Deterministic: fixed tokenization (lowercase, split on non-alphanumerics),
 * fixed shingle size, injected clock. Prompt bodies are required — the
 * worker supplies decrypted text only for workspaces that opted into body
 * logging; metadata-only logs (promptText null) are skipped.
 */

/** Split text into lowercase word tokens. Deterministic. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Word shingles (n-grams) of a text. Texts shorter than the shingle size
 *  yield a single shingle of the whole token list. */
export function tokenShingles(text: string, shingleSize: number): Set<string> {
  const tokens = tokenize(text);
  const shingles = new Set<string>();
  if (tokens.length === 0) return shingles;
  if (tokens.length <= shingleSize) {
    shingles.add(tokens.join(" "));
    return shingles;
  }
  for (let i = 0; i + shingleSize <= tokens.length; i += 1) {
    shingles.add(tokens.slice(i, i + shingleSize).join(" "));
  }
  return shingles;
}

/** Jaccard similarity |A ∩ B| / |A ∪ B|; 0 when both sets are empty. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface WastedTurn {
  log: RequestLog;
  similarity: number;
  overlapTokens: number;
  wastedUsd: number;
}

export class ContextAmnesiaDetector implements WasteDetector {
  readonly name = "context_amnesia" as const;
  readonly version = "1.0.0";

  detect(ctx: DetectorContext): WasteEvent[] {
    const {
      contextAmnesiaJaccardThreshold,
      contextAmnesiaMinOverlapTokens,
      contextAmnesiaShingleSize,
    } = ctx.thresholds;

    const bySession = new Map<string, RequestLog[]>();
    for (const log of ctx.logs) {
      if (log.sessionId === null) continue;
      const bucket = bySession.get(log.sessionId);
      if (bucket === undefined) bySession.set(log.sessionId, [log]);
      else bucket.push(log);
    }

    const events: WasteEvent[] = [];
    const sessionIds = [...bySession.keys()].sort();
    for (const sessionId of sessionIds) {
      const turns = (bySession.get(sessionId) as RequestLog[]).sort(byTimeThenId);
      if (turns.length < 2) continue;

      const wastedTurns: WastedTurn[] = [];
      for (let i = 1; i < turns.length; i += 1) {
        const prev = turns[i - 1] as RequestLog;
        const curr = turns[i] as RequestLog;
        if (prev.promptText === null || curr.promptText === null) continue;
        const similarity = jaccardSimilarity(
          tokenShingles(prev.promptText, contextAmnesiaShingleSize),
          tokenShingles(curr.promptText, contextAmnesiaShingleSize),
        );
        if (similarity < contextAmnesiaJaccardThreshold) continue;
        const overlapTokens = similarity * curr.promptTokens;
        if (overlapTokens < contextAmnesiaMinOverlapTokens) continue;
        wastedTurns.push({
          log: curr,
          similarity,
          overlapTokens,
          wastedUsd: similarity * curr.inputCostUsd,
        });
      }

      if (wastedTurns.length === 0) continue;
      const dollarsWasted = wastedTurns.reduce((s, t) => s + t.wastedUsd, 0);
      events.push(
        makeWasteEvent(
          ctx,
          this,
          wastedTurns.map((t) => t.log.requestId),
          dollarsWasted,
          {
            summary: `Session ${sessionId} repeats background content across ${wastedTurns.length} of ${turns.length} turns.`,
            sessionId,
            turnCount: turns.length,
            wastedTurnCount: wastedTurns.length,
            jaccardThreshold: contextAmnesiaJaccardThreshold,
            shingleSize: contextAmnesiaShingleSize,
            turns: wastedTurns.map((t) => ({
              requestId: t.log.requestId,
              similarity: Math.round(t.similarity * 1e6) / 1e6,
              overlapTokens: Math.round(t.overlapTokens * 100) / 100,
              wastedUsd: Math.round(t.wastedUsd * 1e8) / 1e8,
            })),
          },
          "Consecutive turns in this session resend the same background content. Move stable context into a system prompt or enable prompt caching.",
        ),
      );
    }
    return events;
  }
}
