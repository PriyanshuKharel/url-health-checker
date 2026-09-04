import { randomUUID } from 'node:crypto';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { LIMITS, isTerminalCheck, type BatchSummary, type UrlCheck } from '@uhc/shared';
import {
  claimCheck,
  config,
  finalizeCheck,
  getBatch,
  getCheck,
  markRequestStarted,
  markRetrying,
  publishEvent,
  type BatchListCache,
  type CheckJobData,
  type CheckOutcome,
  type Logger,
} from '@uhc/core';
import { checkUrl, PermanentCheckError, TransientCheckError } from './checker.js';
import type { InflightRegistry } from './inflight.js';
import { waitFor, type GlobalLimiter } from './limiter.js';

/** How long a job waits for a global concurrency slot before going back to the delayed set. */
const SLOT_WAIT_MS = 3_000;
/** How long a single request waits for a rate-limit token. With 5 in flight and 10 req/s this is generous. */
const TOKEN_WAIT_MS = 10_000;

export interface ProcessorContext {
  pool: pg.Pool;
  redis: Redis;
  limiter: GlobalLimiter;
  inflight: InflightRegistry;
  cache: BatchListCache;
  log: Logger;
}

export type ProcessResult = 'completed' | 'skipped' | 'cancelled';

function describeError(err: unknown): { message: string; httpStatus: number | null; permanent: boolean } {
  if (err instanceof PermanentCheckError) return { message: err.message, httpStatus: err.httpStatus, permanent: true };
  if (err instanceof TransientCheckError) return { message: err.message, httpStatus: err.httpStatus, permanent: false };
  if (err instanceof Error && err.name === 'TimeoutError') {
    return { message: `Timed out after ${LIMITS.CHECK_TIMEOUT_MS}ms`, httpStatus: null, permanent: false };
  }
  return { message: err instanceof Error ? err.message : String(err), httpStatus: null, permanent: false };
}

export function createProcessor(ctx: ProcessorContext) {
  const { pool, redis, limiter, inflight, cache, log } = ctx;

  async function emitCheck(check: UrlCheck, batch: BatchSummary) {
    await publishEvent(redis, { type: 'check.updated', batchId: check.batchId, check, batch });
  }

  /** Writes the terminal result; publishes events; completes the batch if this was the last check. */
  async function finish(checkId: string, run: number, outcome: CheckOutcome): Promise<boolean> {
    const result = await finalizeCheck(pool, checkId, run, outcome);
    if (!result) return false; // cancelled meanwhile: DB already says so, nothing to announce
    await emitCheck(result.check, result.batch);
    if (result.batchCompleted) {
      await cache.invalidate();
      await publishEvent(redis, { type: 'batch.updated', batchId: result.batch.id, batch: result.batch, reason: 'completed' });
    }
    return true;
  }

  return async function process(job: Job<CheckJobData>, token?: string): Promise<ProcessResult> {
    const { checkId, batchId, run } = job.data;
    const maxAttempts = job.opts.attempts ?? 1;
    const attemptNo = job.attemptsMade + 1;
    const isFinalAttempt = attemptNo >= maxAttempts;

    // 0. Cheap pre-check so stale (old run) or already-terminal (cancelled) jobs never take a slot.
    const existing = await getCheck(pool, checkId);
    if (!existing || existing.run !== run || isTerminalCheck(existing.status)) {
      log.info('skipping stale or finished job', { checkId, run, status: existing?.status ?? 'missing' });
      return 'skipped';
    }

    // 1. Global concurrency: take one of the 5 system-wide slots or come back later.
    const slotToken = `${config.instanceId}:${job.id}:${randomUUID()}`;
    const gotSlot = await waitFor(() => limiter.tryAcquireSlot(slotToken), SLOT_WAIT_MS);
    if (!gotSlot) {
      // Returns the job to the delayed set without counting an attempt.
      await job.moveToDelayed(Date.now() + 500, token);
      throw new DelayedError();
    }

    const cancel = new AbortController();
    inflight.register(batchId, cancel);

    try {
      // 2. Claim the row (guards against cancel/stale run) and announce "running".
      const claimed = await claimCheck(pool, checkId, run);
      if (!claimed) {
        log.info('claim rejected, job is stale or cancelled', { checkId, run });
        return 'skipped';
      }
      const batchNow = await getBatch(pool, batchId);
      if (batchNow) await emitCheck(claimed, batchNow);

      const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(LIMITS.CHECK_TIMEOUT_MS)]);

      try {
        // 3. Do the HTTP work. Every hop first takes a global rate-limit token.
        let firstRequest = true;
        const result = await checkUrl(claimed.url, {
          signal,
          beforeRequest: async () => {
            const ok = await waitFor(() => limiter.tryAcquireToken(slotToken), TOKEN_WAIT_MS, signal);
            if (!ok) throw new TransientCheckError('Timed out waiting for a rate-limit token');
            if (firstRequest) {
              firstRequest = false;
              await markRequestStarted(pool, checkId, run); // started_at = first request out, for `npm run verify`
            }
          },
        });

        await finish(checkId, run, {
          status: 'completed',
          httpStatus: result.httpStatus,
          responseTimeMs: result.responseTimeMs,
          pageTitle: result.pageTitle,
          finalUrl: result.finalUrl,
          error: null,
        });
        log.info('check completed', { checkId, url: claimed.url, httpStatus: result.httpStatus, ms: result.responseTimeMs, requests: result.requests, attempt: attemptNo });
        return 'completed';
      } catch (err) {
        if (cancel.signal.aborted) {
          // Cancelled by the user while in flight. The cancel transaction already marked the row.
          log.info('check aborted by cancel', { checkId, batchId });
          return 'cancelled';
        }

        const info = describeError(err);

        if (info.permanent) {
          await finish(checkId, run, { status: 'failed', httpStatus: info.httpStatus, responseTimeMs: null, pageTitle: null, finalUrl: null, error: info.message });
          log.warn('check failed permanently', { checkId, url: claimed.url, error: info.message });
          throw new UnrecoverableError(info.message);
        }

        if (isFinalAttempt) {
          await finish(checkId, run, {
            status: 'failed',
            httpStatus: info.httpStatus,
            responseTimeMs: null,
            pageTitle: null,
            finalUrl: null,
            error: `${info.message} (after ${maxAttempts} attempts)`,
          });
          log.warn('check failed after all retries', { checkId, url: claimed.url, error: info.message, attempts: maxAttempts });
          throw err;
        }

        // Transient failure with retries left: back to queued, BullMQ schedules the retry with exponential backoff.
        const retrying = await markRetrying(pool, checkId, run, info.message, info.httpStatus);
        if (retrying) {
          const batch = await getBatch(pool, batchId);
          if (batch) await emitCheck(retrying, batch);
        }
        log.info('check will retry', { checkId, url: claimed.url, error: info.message, attempt: attemptNo, of: maxAttempts });
        throw err;
      }
    } finally {
      inflight.unregister(batchId, cancel);
      await limiter.releaseSlot(slotToken).catch(() => undefined);
    }
  };
}
