import type { Redis } from 'ioredis';
import type { LiveEvent } from '@uhc/shared';

export const CHANNELS = {
  /** Every state change, consumed by API instances and fanned out over SSE. */
  events: 'uhc:events',
  /** Batch ids whose in-flight checks must be aborted, consumed by workers. */
  cancel: 'uhc:cancel',
} as const;

export async function publishEvent(redis: Redis, event: LiveEvent): Promise<void> {
  await redis.publish(CHANNELS.events, JSON.stringify(event));
}

export async function publishCancel(redis: Redis, batchId: string): Promise<void> {
  await redis.publish(CHANNELS.cancel, batchId);
}

/** Subscribes on a dedicated connection. A connection in subscriber mode cannot run other commands. */
export async function subscribe(
  subscriber: Redis,
  channel: string,
  handler: (message: string) => void,
): Promise<void> {
  subscriber.on('message', (ch: string, message: string) => {
    if (ch === channel) handler(message);
  });
  await subscriber.subscribe(channel);
}
