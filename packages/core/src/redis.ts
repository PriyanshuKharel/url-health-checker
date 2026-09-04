import { Redis } from 'ioredis';
import { config } from './config.js';

/** BullMQ requires maxRetriesPerRequest: null on the connections it uses. */
export function createRedis(): Redis {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
}
