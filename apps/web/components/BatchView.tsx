'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { isHealthyHttpStatus, type BatchDetail, type CheckStatus } from '@uhc/shared';
import { api, ApiError } from '@/lib/api';
import { newerBatch, newerCheck } from '@/lib/merge';
import { ProgressBar } from './ProgressBar';
import { BatchStatusBadge, CheckStatusBadge, LiveIndicator } from './StatusBadge';
import { useLiveEvents } from './useLiveEvents';

type Filter = 'all' | CheckStatus;

export function BatchView({ initial }: { initial: BatchDetail }) {
  const [batch, setBatch] = useState(initial.batch);
  const [checks, setChecks] = useState(initial.checks);
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<'cancel' | 'retry' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Full re-sync from Postgres via the API. Used on every (re)connect and after control actions.
  const refetch = useCallback(async () => {
    try {
      const detail = await api.getBatch(batch.id);
      setBatch(detail.batch);
      setChecks(detail.checks);
    } catch {
      /* stream will retry; keep what we have */
    }
  }, [batch.id]);

  const live = useLiveEvents(api.batchEventsUrl(batch.id), {
    onConnect: refetch,
    onMessage: (message) => {
      if (message.type === 'check.updated') {
        setChecks((prev) => prev.map((c) => (c.id === message.check.id && newerCheck(c, message.check) ? message.check : c)));
        setBatch((prev) => (newerBatch(prev, message.batch) ? message.batch : prev));
      } else if (message.type === 'batch.updated') {
        setBatch((prev) => (newerBatch(prev, message.batch) ? message.batch : prev));
        // Cancel and retry change many rows at once; one snapshot fetch beats N events.
        if (message.reason === 'cancelled' || message.reason === 'retry') void refetch();
      }
    },
  });

  async function run(action: 'cancel' | 'retry') {
    setBusy(action);
    setError(null);
    try {
      const res = action === 'cancel' ? await api.cancelBatch(batch.id) : await api.retryFailed(batch.id);
      setBatch((prev) => (newerBatch(prev, res.batch) ? res.batch : prev));
      await refetch();
    } catch (err) {
      setError(err instanceof ApiError ? err.body.error : 'Request failed');
    } finally {
      setBusy(null);
    }
  }

  const visible = useMemo(() => (filter === 'all' ? checks : checks.filter((c) => c.status === filter)), [checks, filter]);

  return (
    <section>
      <p>
        <Link href="/">← All batches</Link>
      </p>
      <div className="card">
        <div className="row between">
          <div>
            <h1 style={{ margin: 0 }}>{batch.name}</h1>
            <div className="muted mono small">
              {batch.id} · created {new Date(batch.createdAt).toLocaleString()}
              {batch.completedAt && <> · finished {new Date(batch.completedAt).toLocaleString()}</>}
            </div>
          </div>
          <div className="row">
            <LiveIndicator state={live} />
            <BatchStatusBadge status={batch.status} />
          </div>
        </div>

        <ProgressBar counts={batch.counts} />

        <div className="row">
          <button onClick={() => run('cancel')} disabled={busy !== null || batch.status !== 'running'} className="danger">
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel batch'}
          </button>
          <button onClick={() => run('retry')} disabled={busy !== null || batch.counts.failed === 0}>
            {busy === 'retry' ? 'Requeuing…' : `Retry failed only (${batch.counts.failed})`}
          </button>
          <label className="row" style={{ marginLeft: 'auto' }}>
            Show
            <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="all">all ({checks.length})</option>
              <option value="queued">queued ({batch.counts.queued})</option>
              <option value="running">running ({batch.counts.running})</option>
              <option value="completed">completed ({batch.counts.completed})</option>
              <option value="failed">failed ({batch.counts.failed})</option>
              <option value="cancelled">cancelled ({batch.counts.cancelled})</option>
            </select>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
      </div>

      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>URL</th>
              <th>Check</th>
              <th>HTTP</th>
              <th>Time</th>
              <th>Title</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => (
              <tr key={c.id} className={`row-${c.status}`}>
                <td className="muted">{c.position + 1}</td>
                <td className="url">
                  <a href={c.url} target="_blank" rel="noreferrer noopener">
                    {c.url}
                  </a>
                </td>
                <td>
                  <CheckStatusBadge status={c.status} attempts={c.attempts} />
                </td>
                <td>
                  {c.httpStatus !== null ? (
                    <span className={isHealthyHttpStatus(c.httpStatus) ? 'http-ok' : 'http-bad'}>{c.httpStatus}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>{c.responseTimeMs !== null ? `${c.responseTimeMs} ms` : <span className="muted">—</span>}</td>
                <td className="title">{c.pageTitle ?? <span className="muted">—</span>}</td>
                <td className="small">
                  {c.error && <div className="c-failed">{c.error}</div>}
                  {c.finalUrl && c.finalUrl !== c.url && <div className="muted">→ {c.finalUrl}</div>}
                  {c.attempts > 1 && c.status !== 'queued' && <div className="muted">{c.attempts} attempts</div>}
                  {c.run > 1 && <div className="muted">run {c.run}</div>}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  Nothing matches this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
