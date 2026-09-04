import type { Redis } from 'ioredis';
import { LIMITS } from '@uhc/shared';

const VERSION_KEY = 'uhc:cache:batches:version';
const PREFIX = 'uhc:cache:batches:list';

/**
 * Versioned cache for the batch list.
 *
 * Invalidation bumps a version counter instead of deleting keys. A slow request
 * that read the DB before an invalidation writes to the *old* version key, so it
 * can never resurrect stale data under the live key.
 */
export class BatchListCache {
  constructor(private readonly redis: Redis) {}

  private async version(): Promise<string> {
    return (await this.redis.get(VERSION_KEY)) ?? '0';
  }

  private key(version: string, suffix: string): string {
    return `${PREFIX}:v${version}:${suffix}`;
  }

  async get<T>(suffix: string): Promise<{ value: T | null; version: string }> {
    const version = await this.version();
    const raw = await this.redis.get(this.key(version, suffix));
    return { value: raw ? (JSON.parse(raw) as T) : null, version };
  }

  async set(suffix: string, version: string, value: unknown): Promise<void> {
    await this.redis.set(this.key(version, suffix), JSON.stringify(value), 'EX', LIMITS.LIST_CACHE_TTL_SECONDS);
  }

  async invalidate(): Promise<void> {
    await this.redis.incr(VERSION_KEY);
  }
}
