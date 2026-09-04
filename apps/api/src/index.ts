import { BatchListCache, config, createCheckQueue, createLogger, createPool, createRedis } from '@uhc/core';
import { buildApp } from './app.js';
import { EventHub } from './eventHub.js';

const log = createLogger('api');

async function main() {
  const pool = createPool();
  const redis = createRedis();
  const subscriber = createRedis();
  const queue = createCheckQueue(redis);
  const cache = new BatchListCache(redis);
  const hub = new EventHub(subscriber);
  await hub.start();

  const app = await buildApp({ pool, redis, queue, cache, hub });
  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: '0.0.0.0' });
  log.info('api listening', { port, instance: config.instanceId });

  const shutdown = async (signal: string) => {
    log.info('shutting down', { signal });
    try {
      await app.close();
      await queue.close();
      await subscriber.quit();
      await redis.quit();
      await pool.end();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('fatal', { error: String(err) });
  process.exit(1);
});
