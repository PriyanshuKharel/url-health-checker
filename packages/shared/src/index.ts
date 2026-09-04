import { z } from 'zod';

/**
 * Types shared between the API, the worker and the Next.js client.
 * This package is the single source of truth for the wire format.
 */

export const CHECK_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const BATCH_STATUSES = ['running', 'completed', 'cancelled'] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const LIMITS = {
  /** Global outbound HTTP requests per second, across every worker process. */
  RATE_LIMIT_PER_SECOND: 10,
  /**
   * The 10-request budget is spread over this window. 1000 ms nominal + 50 ms margin:
   * the margin absorbs network jitter so the limit also holds as measured by the target.
   */
  RATE_WINDOW_MS: 1050,
  /** Global number of URL checks in flight, across every worker process. */
  GLOBAL_CONCURRENCY: 5,
  /** Retries after the first attempt (so 4 attempts in total). */
  MAX_RETRIES: 3,
  /** Base delay for exponential backoff: 1s, 2s, 4s. */
  BACKOFF_BASE_MS: 1000,
  /** Hard deadline for a whole check (all redirect hops + body read). */
  CHECK_TIMEOUT_MS: 15_000,
  MAX_REDIRECTS: 10,
  MAX_URLS_PER_BATCH: 1000,
  LIST_CACHE_TTL_SECONDS: 30,
} as const;

// ---------- request schemas ----------

export const createBatchSchema = z.object({
  name: z.string().trim().max(120).optional(),
  urls: z.array(z.string().trim().min(1).max(2048)).min(1).max(LIMITS.MAX_URLS_PER_BATCH),
});
export type CreateBatchInput = z.infer<typeof createBatchSchema>;

export const listBatchesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListBatchesQuery = z.infer<typeof listBatchesQuerySchema>;

// ---------- response types ----------

export interface BatchCounts {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface BatchSummary {
  id: string;
  name: string;
  status: BatchStatus;
  counts: BatchCounts;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface UrlCheck {
  id: string;
  batchId: string;
  position: number;
  url: string;
  status: CheckStatus;
  /** Incremented every time the URL is re-run via "retry failed". */
  run: number;
  /** Attempts made in the current run (1 initial + up to MAX_RETRIES). */
  attempts: number;
  httpStatus: number | null;
  responseTimeMs: number | null;
  pageTitle: string | null;
  finalUrl: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface BatchDetail {
  batch: BatchSummary;
  checks: UrlCheck[];
}

export interface BatchListResponse {
  batches: BatchSummary[];
  total: number;
  /** When this payload was computed. Served from a 30s cache. */
  cachedAt: string;
}

export interface CreateBatchResponse {
  batch: BatchSummary;
  /** false when an Idempotency-Key replay returned the existing batch. */
  created: boolean;
}

export interface BatchActionResponse {
  batch: BatchSummary;
  /** Number of URL checks affected by the action. */
  affected: number;
}

export interface ApiErrorBody {
  error: string;
  details?: unknown;
}

// ---------- live events (SSE payloads) ----------

export type BatchUpdateReason = 'created' | 'progress' | 'completed' | 'cancelled' | 'retry';

export type LiveEvent =
  | { type: 'check.updated'; batchId: string; check: UrlCheck; batch: BatchSummary }
  | { type: 'batch.updated'; batchId: string; batch: BatchSummary; reason: BatchUpdateReason };

// ---------- helpers ----------

export function isTerminalBatch(status: BatchStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

export function isTerminalCheck(status: CheckStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function isHealthyHttpStatus(code: number | null): boolean {
  return code !== null && code >= 200 && code < 400;
}

export function progressPercent(counts: BatchCounts): number {
  if (counts.total === 0) return 0;
  const done = counts.completed + counts.failed + counts.cancelled;
  return Math.round((done / counts.total) * 100);
}

/**
 * Normalise a user supplied URL. Adds https:// when no scheme was given.
 * Returns null if the result is not a valid http(s) URL.
 */
export function normalizeUrl(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Everything that can arrive on an SSE stream. `hello` is sent once per (re)connection. */
export type SseMessage = LiveEvent | { type: 'hello'; instance: string };

export const CHECK_STATUS_LABELS: Record<CheckStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
