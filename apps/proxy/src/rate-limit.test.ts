import { describe, expect, it } from "vitest";
import RedisMock from "ioredis-mock";
import {
  InMemorySlidingWindowRateLimiter,
  RedisSlidingWindowRateLimiter,
  slidingWindowDecision,
  type RedisWindowCommands,
} from "./rate-limit.js";
import { silentLogger } from "./test-utils.js";

describe("slidingWindowDecision", () => {
  it("allows up to the limit, then denies with retryAfter", () => {
    const now = 10_000;
    let stamps: number[] = [];
    for (let i = 0; i < 3; i++) {
      const d = slidingWindowDecision(stamps, now + i, 3, 60_000);
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(3 - i - 1);
      stamps = d.kept;
    }
    const denied = slidingWindowDecision(stamps, now + 3, 3, 60_000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(60_000 - 3);
    expect(denied.remaining).toBe(0);
  });

  it("slides: aged-out timestamps no longer count", () => {
    const d = slidingWindowDecision([0, 1, 2], 60_002, 3, 60_000);
    expect(d.allowed).toBe(true);
    expect(d.kept).toEqual([60_002]);
  });
});

describe("InMemorySlidingWindowRateLimiter", () => {
  it("burst past limit is denied; window slides", async () => {
    let now = 1_000_000;
    const limiter = new InMemorySlidingWindowRateLimiter({
      limit: 2,
      windowMs: 1_000,
      now: () => now,
      sweepIntervalMs: 0,
    });
    expect((await limiter.consume("k")).allowed).toBe(true);
    expect((await limiter.consume("k")).allowed).toBe(true);
    const denied = await limiter.consume("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1_000);

    now += 500;
    expect((await limiter.consume("k")).allowed).toBe(false); // 2 still in window
    now += 600; // 1.1s after first
    expect((await limiter.consume("k")).allowed).toBe(true);
    await limiter.close();
  });

  it("tracks keys independently and sweeps empty buckets", async () => {
    let now = 0;
    const limiter = new InMemorySlidingWindowRateLimiter({
      limit: 1,
      windowMs: 100,
      now: () => now,
      sweepIntervalMs: 0,
    });
    expect((await limiter.consume("a")).allowed).toBe(true);
    expect((await limiter.consume("b")).allowed).toBe(true);
    expect((await limiter.consume("a")).allowed).toBe(false);
    expect(limiter.bucketCount()).toBe(2);
    now += 200;
    limiter.sweep();
    expect(limiter.bucketCount()).toBe(0);
    await limiter.close();
  });
});

describe("RedisSlidingWindowRateLimiter", () => {
  it("matches in-memory semantics over ioredis-mock", async () => {
    let now = 5_000_000;
    const redis = new RedisMock() as unknown as RedisWindowCommands;
    const limiter = new RedisSlidingWindowRateLimiter({
      limit: 2,
      windowMs: 1_000,
      redis,
      logger: silentLogger,
      now: () => now,
    });
    expect((await limiter.consume("k")).allowed).toBe(true);
    expect((await limiter.consume("k")).allowed).toBe(true);
    const denied = await limiter.consume("k");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1_000);

    now += 1_100; // window slid
    expect((await limiter.consume("k")).allowed).toBe(true);
    await limiter.close();
  });

  it("fails open when redis errors (proxy health independent of Redis)", async () => {
    const broken: RedisWindowCommands = {
      zremrangebyscore: () => Promise.reject(new Error("redis down")),
      zcard: () => Promise.reject(new Error("redis down")),
      zadd: () => Promise.reject(new Error("redis down")),
      zrange: () => Promise.reject(new Error("redis down")),
      pexpire: () => Promise.reject(new Error("redis down")),
    };
    const limiter = new RedisSlidingWindowRateLimiter({
      limit: 1,
      windowMs: 1_000,
      redis: broken,
      logger: silentLogger,
    });
    const result = await limiter.consume("k");
    expect(result.allowed).toBe(true);
    expect(limiter.redisErrorCount()).toBe(1);
    await limiter.close();
  });
});
