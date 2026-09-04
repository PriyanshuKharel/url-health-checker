import type pg from 'pg';
import type { BatchStatus, BatchSummary, CheckStatus, UrlCheck } from '@uhc/shared';
import type { DbClient } from './db.js';

// ---------- row mapping ----------

interface BatchRow {
  id: string;
  name: string;
  status: BatchStatus;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  total: string;
  queued: string;
  running: string;
  completed: string;
  failed: string;
  cancelled: string;
}

interface CheckRow {
  id: string;
  batch_id: string;
  position: number;
  url: string;
  status: CheckStatus;
  run: number;
  attempts: number;
  http_status: number | null;
  response_time_ms: number | null;
  page_title: string | null;
  final_url: string | null;
  error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function mapBatch(r: BatchRow): BatchSummary {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    counts: {
      total: Number(r.total),
      queued: Number(r.queued),
      running: Number(r.running),
      completed: Number(r.completed),
      failed: Number(r.failed),
      cancelled: Number(r.cancelled),
    },
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    completedAt: iso(r.completed_at),
  };
}

export function mapCheck(r: CheckRow): UrlCheck {
  return {
    id: r.id,
    batchId: r.batch_id,
    position: r.position,
    url: r.url,
    status: r.status,
    run: r.run,
    attempts: r.attempts,
    httpStatus: r.http_status,
    responseTimeMs: r.response_time_ms,
    pageTitle: r.page_title,
    finalUrl: r.final_url,
    error: r.error,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Counts are always derived from url_checks: Postgres is the only source of truth for progress. */
const BATCH_SELECT = `
  SELECT b.id, b.name, b.status, b.created_at, b.updated_at, b.completed_at,
         count(c.id)                                        AS total,
         count(c.id) FILTER (WHERE c.status = 'queued')     AS queued,
         count(c.id) FILTER (WHERE c.status = 'running')    AS running,
         count(c.id) FILTER (WHERE c.status = 'completed')  AS completed,
         count(c.id) FILTER (WHERE c.status = 'failed')     AS failed,
         count(c.id) FILTER (WHERE c.status = 'cancelled')  AS cancelled
  FROM batches b
  LEFT JOIN url_checks c ON c.batch_id = b.id`;

const CHECK_COLUMNS = `id, batch_id, position, url, status, run, attempts, http_status, response_time_ms,
  page_title, final_url, error, started_at, finished_at, updated_at`;

// ---------- reads ----------

export async function getBatch(db: DbClient, id: string): Promise<BatchSummary | null> {
  const res = await db.query<BatchRow>(`${BATCH_SELECT} WHERE b.id = $1 GROUP BY b.id`, [id]);
  const row = res.rows[0];
  return row ? mapBatch(row) : null;
}

export async function getBatchByIdempotencyKey(db: DbClient, key: string): Promise<BatchSummary | null> {
  const res = await db.query<BatchRow>(`${BATCH_SELECT} WHERE b.idempotency_key = $1 GROUP BY b.id`, [key]);
  const row = res.rows[0];
  return row ? mapBatch(row) : null;
}

export async function listBatches(
  db: DbClient,
  limit: number,
  offset: number,
): Promise<{ batches: BatchSummary[]; total: number }> {
  const [rows, count] = await Promise.all([
    db.query<BatchRow>(`${BATCH_SELECT} GROUP BY b.id ORDER BY b.created_at DESC LIMIT $1 OFFSET $2`, [
      limit,
      offset,
    ]),
    db.query<{ n: string }>('SELECT count(*) AS n FROM batches'),
  ]);
  return { batches: rows.rows.map(mapBatch), total: Number(count.rows[0]?.n ?? 0) };
}

export async function getChecks(db: DbClient, batchId: string): Promise<UrlCheck[]> {
  const res = await db.query<CheckRow>(
    `SELECT ${CHECK_COLUMNS} FROM url_checks WHERE batch_id = $1 ORDER BY position ASC`,
    [batchId],
  );
  return res.rows.map(mapCheck);
}

export async function getCheck(db: DbClient, id: string): Promise<UrlCheck | null> {
  const res = await db.query<CheckRow>(`SELECT ${CHECK_COLUMNS} FROM url_checks WHERE id = $1`, [id]);
  const row = res.rows[0];
  return row ? mapCheck(row) : null;
}

// ---------- batch creation ----------

export interface CreatedBatch {
  batch: BatchSummary;
  checks: Array<{ id: string; batchId: string; run: number }>;
}

export async function insertBatch(
  tx: pg.PoolClient,
  input: { name: string; urls: string[]; idempotencyKey: string | null },
): Promise<CreatedBatch> {
  const batchRes = await tx.query<{ id: string }>(
    `INSERT INTO batches (name, status, idempotency_key) VALUES ($1, 'running', $2) RETURNING id`,
    [input.name, input.idempotencyKey],
  );
  const batchId = batchRes.rows[0]!.id;

  // One INSERT for all URLs via unnest keeps this a single round trip even for 1000 URLs.
  const positions = input.urls.map((_, i) => i);
  const checkRes = await tx.query<{ id: string }>(
    `INSERT INTO url_checks (batch_id, position, url, status)
     SELECT $1, p, u, 'queued' FROM unnest($2::int[], $3::text[]) AS t(p, u)
     ORDER BY p
     RETURNING id`,
    [batchId, positions, input.urls],
  );

  const batch = (await getBatch(tx, batchId))!;
  return { batch, checks: checkRes.rows.map((r) => ({ id: r.id, batchId, run: 1 })) };
}

// ---------- controls ----------

export interface CancelResult {
  batch: BatchSummary;
  /** Checks that were queued or running and are now cancelled (their jobs get removed from the queue). */
  cancelled: Array<{ id: string; run: number; previousStatus: CheckStatus }>;
}

/** Cancels a batch. Idempotent: cancelling a finished or cancelled batch changes nothing. */
export async function cancelBatch(tx: pg.PoolClient, batchId: string): Promise<CancelResult | null> {
  const lock = await tx.query<{ status: BatchStatus }>('SELECT status FROM batches WHERE id = $1 FOR UPDATE', [
    batchId,
  ]);
  const current = lock.rows[0];
  if (!current) return null;
  if (current.status !== 'running') {
    return { batch: (await getBatch(tx, batchId))!, cancelled: [] };
  }

  const cancelled = await tx.query<{ id: string; run: number; previous_status: CheckStatus }>(
    `UPDATE url_checks AS c
        SET status = 'cancelled', finished_at = now(), updated_at = now()
       FROM (SELECT id, status AS previous_status FROM url_checks
              WHERE batch_id = $1 AND status IN ('queued','running') FOR UPDATE) AS prev
      WHERE c.id = prev.id
      RETURNING c.id, c.run, prev.previous_status`,
    [batchId],
  );
  await tx.query(`UPDATE batches SET status = 'cancelled', completed_at = now(), updated_at = now() WHERE id = $1`, [
    batchId,
  ]);
  return {
    batch: (await getBatch(tx, batchId))!,
    cancelled: cancelled.rows.map((r) => ({ id: r.id, run: r.run, previousStatus: r.previous_status })),
  };
}

export interface RetryResult {
  batch: BatchSummary;
  requeued: Array<{ id: string; batchId: string; run: number }>;
}

/**
 * Re-runs only checks in the `failed` state. Each gets a new `run` number, which
 * both yields a fresh BullMQ job id and makes any straggling job for the old run stale.
 */
export async function retryFailed(tx: pg.PoolClient, batchId: string): Promise<RetryResult | null> {
  const lock = await tx.query<{ status: BatchStatus }>('SELECT status FROM batches WHERE id = $1 FOR UPDATE', [
    batchId,
  ]);
  if (!lock.rows[0]) return null;

  const res = await tx.query<{ id: string; run: number }>(
    `UPDATE url_checks
        SET status = 'queued', run = run + 1, attempts = 0,
            http_status = NULL, response_time_ms = NULL, page_title = NULL, final_url = NULL,
            error = NULL, started_at = NULL, finished_at = NULL, updated_at = now()
      WHERE batch_id = $1 AND status = 'failed'
      RETURNING id, run`,
    [batchId],
  );
  if (res.rowCount) {
    await tx.query(`UPDATE batches SET status = 'running', completed_at = NULL, updated_at = now() WHERE id = $1`, [
      batchId,
    ]);
  }
  return {
    batch: (await getBatch(tx, batchId))!,
    requeued: res.rows.map((r) => ({ id: r.id, batchId, run: r.run })),
  };
}

// ---------- worker transitions ----------

/**
 * Marks a check as running for the given run. Returns null when the job is stale
 * (run mismatch) or the check already reached a terminal state (e.g. cancelled).
 * Accepts `running` too so a job re-delivered after a worker crash can resume.
 */
export async function claimCheck(db: DbClient, checkId: string, run: number): Promise<UrlCheck | null> {
  const res = await db.query<CheckRow>(
    `UPDATE url_checks
        SET status = 'running', attempts = attempts + 1, updated_at = now()
      WHERE id = $1 AND run = $2 AND status IN ('queued', 'running')
      RETURNING ${CHECK_COLUMNS}`,
    [checkId, run],
  );
  const row = res.rows[0];
  return row ? mapCheck(row) : null;
}

/** Stamps the moment the first HTTP request of this attempt actually went out (after the rate-limit token). */
export async function markRequestStarted(db: DbClient, checkId: string, run: number): Promise<void> {
  await db.query(`UPDATE url_checks SET started_at = now() WHERE id = $1 AND run = $2 AND status = 'running'`, [
    checkId,
    run,
  ]);
}

export interface CheckOutcome {
  status: 'completed' | 'failed';
  httpStatus: number | null;
  responseTimeMs: number | null;
  pageTitle: string | null;
  finalUrl: string | null;
  error: string | null;
}

export interface FinalizeResult {
  check: UrlCheck;
  batch: BatchSummary;
  batchCompleted: boolean;
}

/**
 * Writes a terminal result and, in the same transaction, completes the batch when
 * no queued/running checks remain. The batch row is locked first so two workers
 * finishing the last two checks concurrently serialise and exactly one completes it.
 * Returns null when the row was no longer running for this run (cancelled meanwhile).
 */
export async function finalizeCheck(
  pool: pg.Pool,
  checkId: string,
  run: number,
  outcome: CheckOutcome,
): Promise<FinalizeResult | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owner = await client.query<{ batch_id: string }>(
      `SELECT c.batch_id FROM url_checks c JOIN batches b ON b.id = c.batch_id
        WHERE c.id = $1 FOR UPDATE OF b`,
      [checkId],
    );
    const batchId = owner.rows[0]?.batch_id;
    if (!batchId) {
      await client.query('ROLLBACK');
      return null;
    }
    const res = await client.query<CheckRow>(
      `UPDATE url_checks
          SET status = $3, http_status = $4, response_time_ms = $5, page_title = $6, final_url = $7,
              error = $8, finished_at = now(), updated_at = now()
        WHERE id = $1 AND run = $2 AND status = 'running'
        RETURNING ${CHECK_COLUMNS}`,
      [
        checkId,
        run,
        outcome.status,
        outcome.httpStatus,
        outcome.responseTimeMs,
        outcome.pageTitle,
        outcome.finalUrl,
        outcome.error,
      ],
    );
    const row = res.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }
    const done = await client.query(
      `UPDATE batches SET status = 'completed', completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'running'
          AND NOT EXISTS (SELECT 1 FROM url_checks WHERE batch_id = $1 AND status IN ('queued','running'))`,
      [batchId],
    );
    const batch = (await getBatch(client, batchId))!;
    await client.query('COMMIT');
    return { check: mapCheck(row), batch, batchCompleted: (done.rowCount ?? 0) > 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Puts a running check back to queued between BullMQ retry attempts, recording the transient error. */
export async function markRetrying(
  db: DbClient,
  checkId: string,
  run: number,
  error: string,
  httpStatus: number | null,
): Promise<UrlCheck | null> {
  const res = await db.query<CheckRow>(
    `UPDATE url_checks
        SET status = 'queued', error = $3, http_status = $4, updated_at = now()
      WHERE id = $1 AND run = $2 AND status = 'running'
      RETURNING ${CHECK_COLUMNS}`,
    [checkId, run, error, httpStatus],
  );
  const row = res.rows[0];
  return row ? mapCheck(row) : null;
}

/**
 * Queued checks whose job may have been lost (e.g. a crash between COMMIT and enqueue).
 * Re-enqueueing them is safe because job ids are deterministic.
 */
export async function findStaleQueuedChecks(
  db: DbClient,
  olderThanSeconds: number,
  limit: number,
): Promise<Array<{ id: string; batchId: string; run: number }>> {
  const res = await db.query<{ id: string; batch_id: string; run: number }>(
    `SELECT id, batch_id, run FROM url_checks
      WHERE status = 'queued' AND updated_at < now() - ($1 || ' seconds')::interval
      ORDER BY updated_at ASC LIMIT $2`,
    [String(olderThanSeconds), limit],
  );
  return res.rows.map((r) => ({ id: r.id, batchId: r.batch_id, run: r.run }));
}
