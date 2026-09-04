import type {
  ApiErrorBody,
  BatchActionResponse,
  BatchDetail,
  BatchListResponse,
  CreateBatchInput,
  CreateBatchResponse,
} from '@uhc/shared';

/** Port the API gateway is published on. Only used for the hostname-derived fallback below. */
const API_PORT = process.env.NEXT_PUBLIC_API_PORT ?? '4000';

/**
 * Server components talk to the API over the internal Docker network (`API_INTERNAL_URL`).
 *
 * The browser needs a *publicly reachable* origin. `NEXT_PUBLIC_API_URL` is inlined at
 * build time, so hardcoding a default of localhost would break the moment the UI is
 * opened from another machine: the browser would call its own localhost. Instead the
 * origin is derived from whatever host served the page, which works unchanged on
 * localhost, over a LAN IP, or through a tunnel. Set `NEXT_PUBLIC_API_URL` at build
 * time to override, e.g. when the API lives on its own domain behind a proxy.
 */
export function apiBase(): string {
  if (typeof window === 'undefined') {
    return process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  }
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  return `${window.location.protocol}//${window.location.hostname}:${API_PORT}`;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(body.error);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    // The API owns caching (30s Redis cache on the list). Never let fetch/Next add a second layer.
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    let body: ApiErrorBody;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      body = { error: res.statusText || `HTTP ${res.status}` };
    }
    throw new ApiError(res.status, body);
  }
  return (await res.json()) as T;
}

export const api = {
  listBatches: () => request<BatchListResponse>('/api/batches?limit=100'),
  getBatch: (id: string) => request<BatchDetail>(`/api/batches/${encodeURIComponent(id)}`),
  createBatch: (input: CreateBatchInput, idempotencyKey: string) =>
    request<CreateBatchResponse>('/api/batches', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
  cancelBatch: (id: string) =>
    request<BatchActionResponse>(`/api/batches/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  retryFailed: (id: string) =>
    request<BatchActionResponse>(`/api/batches/${encodeURIComponent(id)}/retry-failed`, { method: 'POST' }),
  batchEventsUrl: (id: string) => `${apiBase()}/api/batches/${encodeURIComponent(id)}/events`,
  allEventsUrl: () => `${apiBase()}/api/events`,
};
