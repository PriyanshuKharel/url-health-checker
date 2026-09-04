import type { Redis } from 'ioredis';

const SLOT_KEY = 'uhc:limiter:slots';
const RATE_KEY = 'uhc:limiter:requests';

/**
 * Global concurrency semaphore. Slots live in a sorted set scored by lease expiry,
 * so a slot held by a crashed worker frees itself once the lease runs out.
 * Uses Redis server time so worker clocks do not need to agree.
 */
const ACQUIRE_SLOT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local max = tonumber(ARGV[1])
local lease = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) < max then
  redis.call('ZADD', KEYS[1], now + lease, ARGV[3])
  return 0
end
return 100
`;

/**
 * Global sliding-window rate limit: at most `max` requests in any `window` µs,
 * measured across every worker process. Works in microseconds so that rounding
 * can never let two grants that are 999.9 ms apart look 1000 ms apart.
 * Returns 0 when a token was taken, or the number of ms until the oldest
 * in-window request falls out of the window.
 */
const ACQUIRE_TOKEN = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000000 + tonumber(t[2])
local max = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', string.format('(%d', now - window))
if redis.call('ZCARD', KEYS[1]) < max then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], math.ceil(window / 1000) * 2)
  return 0
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return math.ceil(((tonumber(oldest[2]) + window) - now) / 1000) + 1
`;

export interface LimiterOptions {
  maxConcurrency: number;
  ratePerSecond: number;
  /**
   * Window the `ratePerSecond` budget is spread over. 1000 ms is the nominal value; a
   * small margin on top absorbs network jitter so an observer at the *receiving* end
   * also never counts more than `ratePerSecond` arrivals in any second.
   */
  rateWindowMs: number;
  slotLeaseMs: number;
}

export class GlobalLimiter {
  private counter = 0;

  constructor(
    private readonly redis: Redis,
    private readonly opts: LimiterOptions,
  ) {}

  /** @returns 0 if the slot was acquired, otherwise a suggested wait in ms. */
  async tryAcquireSlot(token: string): Promise<number> {
    const result = await this.redis.eval(ACQUIRE_SLOT, 1, SLOT_KEY, this.opts.maxConcurrency, this.opts.slotLeaseMs, token);
    return Number(result);
  }

  async releaseSlot(token: string): Promise<void> {
    await this.redis.zrem(SLOT_KEY, token);
  }

  /** @returns 0 if a request token was taken, otherwise ms to wait before trying again. */
  async tryAcquireToken(owner: string): Promise<number> {
    const member = `${owner}:${++this.counter}`;
    const result = await this.redis.eval(ACQUIRE_TOKEN, 1, RATE_KEY, this.opts.ratePerSecond, this.opts.rateWindowMs * 1000, member);
    return Number(result);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Polls `attempt` until it returns 0 (acquired) or `maxWaitMs` has elapsed.
 * Sleeps for the hint returned by the limiter, capped so waiters stay responsive.
 */
export async function waitFor(
  attempt: () => Promise<number>,
  maxWaitMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const wait = await attempt();
    if (wait <= 0) return true;
    if (Date.now() - started >= maxWaitMs) return false;
    await sleep(Math.min(Math.max(wait, 10), 250), signal);
  }
}
