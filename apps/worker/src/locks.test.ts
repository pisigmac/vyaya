import RedisMock from "ioredis-mock";
import { describe, expect, it } from "vitest";
import {
  InMemoryJobLock,
  RedisJobLock,
  type RedisLockCommands,
} from "./locks.js";

describe("InMemoryJobLock", () => {
  it("grants one holder at a time and releases by token", async () => {
    const lock = new InMemoryJobLock();
    const token = await lock.acquire("job", 60_000);
    expect(token).toBeTruthy();
    expect(await lock.acquire("job", 60_000)).toBeNull(); // held
    await lock.release("job", "wrong-token");
    expect(await lock.acquire("job", 60_000)).toBeNull(); // still held
    await lock.release("job", token ?? "");
    expect(await lock.acquire("job", 60_000)).toBeTruthy(); // free again
  });

  it("expires locks after the ttl", async () => {
    let now = 1_000;
    const lock = new InMemoryJobLock(() => now);
    expect(await lock.acquire("job", 500)).toBeTruthy();
    now = 1_400;
    expect(await lock.acquire("job", 500)).toBeNull();
    now = 1_501;
    expect(await lock.acquire("job", 500)).toBeTruthy();
  });
});

describe("RedisJobLock (ioredis-mock)", () => {
  it("matches in-memory semantics over the Redis command path", async () => {
    const redis = new RedisMock() as unknown as RedisLockCommands;
    const lock = new RedisJobLock(redis);
    const token = await lock.acquire("vyaya:job:classify", 60_000);
    expect(token).toBeTruthy();
    // Same key: blocked. Different key: free.
    expect(await lock.acquire("vyaya:job:classify", 60_000)).toBeNull();
    expect(await lock.acquire("vyaya:job:retention", 60_000)).toBeTruthy();
    // Wrong token cannot release.
    await lock.release("vyaya:job:classify", "nope");
    expect(await lock.acquire("vyaya:job:classify", 60_000)).toBeNull();
    // Holder releases.
    await lock.release("vyaya:job:classify", token ?? "");
    expect(await lock.acquire("vyaya:job:classify", 60_000)).toBeTruthy();
    await lock.close();
  });
});
