import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

/**
 * Mutual exclusion for scheduled jobs. Redis when REDIS_URL is set
 * (multi-replica deploys), in-memory otherwise (single-process dev). Both
 * implementations share the same acquire/release/token semantics; a lock
 * auto-expires after ttlMs so a crashed holder never wedges a job forever.
 *
 * Lock failures are non-fatal: when Redis errors we log-and-skip the run
 * (fail closed on lock acquisition, never run the same job twice).
 */
export interface JobLock {
  /** Returns an opaque release token, or null when the lock is held. */
  acquire(key: string, ttlMs: number): Promise<string | null>;
  release(key: string, token: string): Promise<void>;
  close(): Promise<void>;
}

interface MemoryEntry {
  token: string;
  expiresAtMs: number;
}

export class InMemoryJobLock implements JobLock {
  readonly #locks = new Map<string, MemoryEntry>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  acquire(key: string, ttlMs: number): Promise<string | null> {
    const existing = this.#locks.get(key);
    if (existing !== undefined && existing.expiresAtMs > this.#now()) {
      return Promise.resolve(null);
    }
    const token = randomUUID();
    this.#locks.set(key, { token, expiresAtMs: this.#now() + ttlMs });
    return Promise.resolve(token);
  }

  release(key: string, token: string): Promise<void> {
    // Only the holder may release; an expired-then-reacquired lock belongs
    // to someone else now.
    if (this.#locks.get(key)?.token === token) {
      this.#locks.delete(key);
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#locks.clear();
    return Promise.resolve();
  }
}

/** Subset of ioredis used here, so tests can substitute ioredis-mock. */
export interface RedisLockCommands {
  set(
    key: string,
    value: string,
    pxToken: "PX",
    px: number,
    nxToken: "NX",
  ): Promise<"OK" | null>;
  eval(
    script: string,
    numKeys: number,
    key: string,
    token: string,
  ): Promise<unknown>;
  quit(): Promise<unknown>;
}

const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export class RedisJobLock implements JobLock {
  readonly #redis: RedisLockCommands;

  constructor(redis: RedisLockCommands) {
    this.#redis = redis;
  }

  static fromUrl(redisUrl: string): RedisJobLock {
    return new RedisJobLock(
      new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 }),
    );
  }

  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const result = await this.#redis.set(key, token, "PX", ttlMs, "NX");
    return result === "OK" ? token : null;
  }

  async release(key: string, token: string): Promise<void> {
    await this.#redis.eval(RELEASE_SCRIPT, 1, key, token);
  }

  async close(): Promise<void> {
    await this.#redis.quit();
  }
}
