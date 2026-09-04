import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { LIMITS } from '@uhc/shared';

export const CHECK_QUEUE = 'url-checks';

export interface CheckJobData {
  checkId: string;
  batchId: string;
  /** Must match url_checks.run, otherwise the job is stale and is skipped. */
  run: number;
}

/**
 * Deterministic job ids make enqueueing idempotent: adding the same (check, run)
 * twice is a no-op in BullMQ, so a crashed enqueue can simply be repeated.
 */
export function jobIdFor(checkId: string, run: number): string {
  return `check:${checkId}:${run}`;
}

export const defaultJobOptions: JobsOptions = {
  attempts: 1 + LIMITS.MAX_RETRIES,
  backoff: { type: 'exponential', delay: LIMITS.BACKOFF_BASE_MS },
  removeOnComplete: { count: 5000 },
  removeOnFail: { count: 5000 },
};

export function createCheckQueue(connection: Redis): Queue<CheckJobData> {
  return new Queue<CheckJobData>(CHECK_QUEUE, { connection, defaultJobOptions });
}

export async function enqueueChecks(
  queue: Queue<CheckJobData>,
  checks: Array<{ id: string; batchId: string; run: number }>,
): Promise<void> {
  if (checks.length === 0) return;
  await queue.addBulk(
    checks.map((c) => ({
      name: 'check',
      data: { checkId: c.id, batchId: c.batchId, run: c.run },
      opts: { jobId: jobIdFor(c.id, c.run) },
    })),
  );
}
