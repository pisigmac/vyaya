import type { Logger } from "pino";

/**
 * Per-API-key sliding-window rate limiter.
 *
 * Two backends with identical semantics:
 *   - InMemorySlidingWindowRateLimiter (default; REDIS_URL unset)
 *   - RedisSlidingWindowRateLimiter (sorted sets; works with ioredis or
 *     ioredis-mock — anything implementing RedisWindowCommands)
 *
 * Window semantics (both backends): a request is allowed when fewer than
 * `limit` requests for the key landed in the trailing `windowMs`. When
 * rejected, retryAfterMs is the time until the oldest in-window request
 * ages out. Proxy health is independent of Redis: Redis errors fail OPEN
 * (request allowed) and are counted.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the oldest in-window request expires (0 when allowed). */
  retryAfterMs: number;
  /** Requests remaining in the current window after this decision. */
  remaining: number;
}

export interface RateLimiter {
  consume(bucketKey: string): Promise<RateLimitResult>;
  close(): Promise<void>;
}

/** Pure decision function shared by both backends. */
export function slidingWindowDecision(
  inWindow: readonly number[],
  now: number,
  limit: number,
  windowMs: number,
): RateLimitResult & { kept: number[] } {
  const cutoff = now - windowMs;
  const kept = inWindow.filter((t) => t > cutoff);
  if (kept.length < limit) {
    kept.push(now);
    return { allowed: true, retryAfterMs: 0, remaining: limit - kept.length, kept };
  }
  const oldest = kept[0]!;
  return {
    allowed: false,
    retryAfterMs: Math.max(1, oldest + windowMs - now),
    remaining: 0,
    kept,
  };
}

export interface InMemoryRateLimiterOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Periodic sweep of empty buckets (unref'd; 0 disables). */
  sweepIntervalMs?: number;
}

export class InMemorySlidingWindowRateLimiter implements RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, number[]>();
  #sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(options: InMemoryRateLimiterOptions) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
    const sweep = options.sweepIntervalMs ?? options.windowMs;
    if (sweep > 0) {
      this.#sweeper = setInterval(() => this.sweep(), sweep);
      this.#sweeper.unref?.();
    }
  }

  consume(bucketKey: string): Promise<RateLimitResult> {
    const decision = slidingWindowDecision(
      this.#buckets.get(bucketKey) ?? [],
      this.#now(),
      this.#limit,
      this.#windowMs,
    );
    this.#buckets.set(bucketKey, decision.kept);
    const { kept: _kept, ...result } = decision;
    return Promise.resolve(result);
  }

  sweep(): void {
    const cutoff = this.#now() - this.#windowMs;
    for (const [key, stamps] of this.#buckets) {
      const kept = stamps.filter((t) => t > cutoff);
      if (kept.length === 0) this.#buckets.delete(key);
      else this.#buckets.set(key, kept);
    }
  }

  bucketCount(): number {
    return this.#buckets.size;
  }

  close(): Promise<void> {
    if (this.#sweeper !== null) {
      clearInterval(this.#sweeper);
      this.#sweeper = null;
    }
    return Promise.resolve();
  }
}

/** The sorted-set command subset the Redis backend needs (ioredis-compatible). */
export interface RedisWindowCommands {
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
  zcard(key: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  pexpire(key: string, ms: number): Promise<unknown>;
}

export interface RedisRateLimiterOptions {
  limit: number;
  windowMs: number;
  redis: RedisWindowCommands;
  logger: Logger;
  now?: () => number;
  keyPrefix?: string;
}

export class RedisSlidingWindowRateLimiter implements RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #redis: RedisWindowCommands;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #keyPrefix: string;
  #memberCounter = 0;
  #redisErrors = 0;

  constructor(options: RedisRateLimiterOptions) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#redis = options.redis;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#keyPrefix = options.keyPrefix ?? "vyaya:rl:";
  }

  async consume(bucketKey: string): Promise<RateLimitResult> {
    const key = `${this.#keyPrefix}${bucketKey}`;
    const now = this.#now();
    const cutoff = now - this.#windowMs;
    try {
      await this.#redis.zremrangebyscore(key, 0, cutoff);
      const count = await this.#redis.zcard(key);
      if (count < this.#limit) {
        this.#memberCounter += 1;
        await this.#redis.zadd(key, now, `${now}:${this.#memberCounter}`);
        await this.#redis.pexpire(key, this.#windowMs);
        return { allowed: true, retryAfterMs: 0, remaining: this.#limit - count - 1 };
      }
      const oldestMember = (await this.#redis.zrange(key, 0, 0))[0];
      const oldestScore =
        oldestMember !== undefined ? Number.parseFloat(oldestMember) : Number.NaN;
      const retryAfterMs = Number.isFinite(oldestScore)
        ? Math.max(1, oldestScore + this.#windowMs - now)
        : this.#windowMs;
      return { allowed: false, retryAfterMs, remaining: 0 };
    } catch (err) {
      // Fail open: proxy health is independent of Redis health.
      this.#redisErrors += 1;
      this.#logger.warn({ err, bucketKey }, "redis rate-limit error; allowing request");
      return { allowed: true, retryAfterMs: 0, remaining: this.#limit };
    }
  }

  redisErrorCount(): number {
    return this.#redisErrors;
  }

  close(): Promise<void> {
    const maybeQuit = this.#redis as Partial<{ quit: () => Promise<unknown> }>;
    return Promise.resolve(maybeQuit.quit?.()).then(() => undefined);
  }
}
