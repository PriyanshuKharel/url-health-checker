import { Worker } from 'bullmq';
import { LIMITS } from '@uhc/shared';
import {
  BatchListCache,
  CHANNELS,
  CHECK_QUEUE,
  config,
  createCheckQueue,
  createLogger,
  createPool,
  createRedis,
  enqueueChecks,
  finalizeCheck,
  findStaleQueuedChecks,
  publishEvent,
  subscribe,
  type CheckJobData,
} from '@uhc/core';
import { GlobalLimiter } from './limiter.js';
import { InflightRegistry } from './inflight.js';
import { createProcessor, type ProcessResult } from './processor.js';

const log = createLogger('worker');

/** Re-enqueue queued checks that have been sitting idle this long (lost enqueue after a crash). */
const RECONCILE_STALE_SECONDS = 120;
const RECONCILE_INTERVAL_MS = 60_000;

async function main() {
  const pool = createPool();
  const redis = createRedis();
  const subscriber = createRedis();
  const queue = createCheckQueue(redis);
  const cache = new BatchListCache(redis);
  const inflight = new InflightRegistry();
  const limiter = new GlobalLimiter(redis, {
    maxConcurrency: LIMITS.GLOBAL_CONCURRENCY,
    ratePerSecond: LIMITS.RATE_LIMIT_PER_SECOND,
    rateWindowMs: LIMITS.RATE_WINDOW_MS,
    slotLeaseMs: 60_000,
  });

  // Cancel fan-in: abort any in-flight fetch for the cancelled batch.
  await subscribe(subscriber, CHANNELS.cancel, (batchId) => {
    const aborted = inflight.abortAll(batchId);
    if (aborted > 0) log.info('aborted in-flight checks for cancelled batch', { batchId, aborted });
  });

  const worker = new Worker<CheckJobData, ProcessResult>(
    CHECK_QUEUE,
    createProcessor({ pool, redis, limiter, inflight, cache, log }),
    {
      connection: redis,
      // Local cap; the *global* cap of 5 is enforced by the Redis semaphore in the processor.
      concurrency: LIMITS.GLOBAL_CONCURRENCY,
      lockDuration: 30_000,
      stalledInterval: 30_000,
    },
  );

  worker.on('ready', () => log.info('worker ready', { instance: config.instanceId, queue: CHECK_QUEUE }));
  worker.on('error', (err) => log.error('worker error', { error: err.message }));
  worker.on('stalled', (jobId) => log.warn('job stalled', { jobId }));

  // Safety net for jobs whose processor never got to write a result, e.g. a job that
  // stalled past maxStalledCount after a worker crash. The status guard inside
  // finalizeCheck makes this a no-op for anything the processor already handled.
  worker.on('failed', async (job, err) => {
    if (!job) return;
    try {
      const result = await finalizeCheck(pool, job.data.checkId, job.data.run, {
        status: 'failed',
        httpStatus: null,
        responseTimeMs: null,
        pageTitle: null,
        finalUrl: null,
        error: err.message,
      });
      if (result) {
        log.warn('marked orphaned job as failed', { checkId: job.data.checkId, error: err.message });
        await publishEvent(redis, { type: 'check.updated', batchId: result.batch.id, check: result.check, batch: result.batch });
        if (result.batchCompleted) {
          await cache.invalidate();
          await publishEvent(redis, { type: 'batch.updated', batchId: result.batch.id, batch: result.batch, reason: 'completed' });
        }
      }
    } catch (e) {
      log.error('failed-event handler error', { error: String(e) });
    }
  });

  // Reconciler: repair the gap between "rows committed" and "jobs enqueued" if the API crashed in between.
  const reconcile = async () => {
    try {
      const stale = await findStaleQueuedChecks(pool, RECONCILE_STALE_SECONDS, 500);
      if (stale.length > 0) {
        await enqueueChecks(queue, stale);
        log.info('reconciler re-enqueued queued checks (duplicates are ignored by BullMQ)', { count: stale.length });
      }
    } catch (e) {
      log.error('reconciler error', { error: String(e) });
    }
  };
  const reconciler = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    log.info('shutting down, waiting for in-flight checks', { signal, inflight: inflight.size });
    clearInterval(reconciler);
    try {
      await worker.close();
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
