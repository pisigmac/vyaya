/**
 * X-Vyaya-Tag validation against the per-workspace allowlist.
 *
 * Semantics (documented in docs/ASSUMPTIONS.md):
 *   - workspace has rows in feature_tag_allowlist -> tag must be one of them
 *   - workspace has no rows -> FEATURE_TAG_ALLOWLIST env list applies;
 *     empty env list means allow all
 *   - a rejected tag NEVER fails the request: it is logged with
 *     feature_tag = null and a warn line.
 *
 * Lookups are cached per workspace with a short TTL (allowlist edits take
 * up to TTL to propagate).
 */

export interface FeatureTagStore {
  listTags(workspaceId: string): Promise<string[]>;
}

export interface FeatureTagCheckerOptions {
  cacheTtlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  tags: ReadonlySet<string>;
  /** True when the workspace table had at least one row. */
  workspaceScoped: boolean;
  expiresAt: number;
}

export class FeatureTagChecker {
  readonly #store: FeatureTagStore;
  readonly #envAllowlist: ReadonlySet<string>;
  readonly #cacheTtlMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(
    store: FeatureTagStore,
    envAllowlist: readonly string[],
    options: FeatureTagCheckerOptions = {},
  ) {
    this.#store = store;
    this.#envAllowlist = new Set(envAllowlist);
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Resolve the tag to log: the tag itself when allowed, else null. */
  async resolve(workspaceId: string, tag: string | null): Promise<string | null> {
    if (tag === null) return null;
    try {
      const entry = await this.#entry(workspaceId);
      if (entry.workspaceScoped) {
        return entry.tags.has(tag) ? tag : null;
      }
      if (this.#envAllowlist.size === 0) return tag;
      return this.#envAllowlist.has(tag) ? tag : null;
    } catch {
      // Allowlist store down: do not fail or silently mislabel — drop the tag.
      return null;
    }
  }

  async #entry(workspaceId: string): Promise<CacheEntry> {
    const now = this.#now();
    const cached = this.#cache.get(workspaceId);
    if (cached !== undefined && cached.expiresAt > now) return cached;
    const rows = await this.#store.listTags(workspaceId);
    const entry: CacheEntry = {
      tags: new Set(rows),
      workspaceScoped: rows.length > 0,
      expiresAt: now + this.#cacheTtlMs,
    };
    this.#cache.set(workspaceId, entry);
    return entry;
  }
}
