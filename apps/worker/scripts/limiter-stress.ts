import { Redis } from "ioredis";
import { GlobalLimiter, waitFor } from "../src/limiter.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});
const limiter = new GlobalLimiter(redis, {
  maxConcurrency: 5,
  ratePerSecond: 10,
  rateWindowMs: 1050,
  slotLeaseMs: 60_000,
});
const TOKENS_PER_CLIENT = 40;
const CLIENTS = 8;
const acquired: number[] = [];

async function client(id: number) {
  for (let i = 0; i < TOKENS_PER_CLIENT; i++) {
    const ok = await waitFor(
      () => limiter.tryAcquireToken(`stress-${id}`),
      30_000,
    );
    if (!ok) throw new Error("timed out");
    acquired.push(Date.now());
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: CLIENTS }, (_, i) => client(i)));
const elapsed = Date.now() - t0;
acquired.sort((a, b) => a - b);
let max = 0;
for (let i = 0, j = 0; i < acquired.length; i++) {
  while (acquired[i]! - acquired[j]! >= 1000) j++;
  max = Math.max(max, i - j + 1);
}
console.log(
  JSON.stringify({
    tokens: acquired.length,
    elapsedMs: elapsed,
    effectiveRate: (acquired.length / elapsed) * 1000,
    maxInAnySlidingSecond: max,
  }),
);
await redis.quit();
