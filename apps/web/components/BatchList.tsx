'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import type { BatchListResponse } from '@uhc/shared';
import { api } from '@/lib/api';
import { upsertBatch } from '@/lib/merge';
import { ProgressBar } from './ProgressBar';
import { BatchStatusBadge, LiveIndicator } from './StatusBadge';
import { useLiveEvents } from './useLiveEvents';

export function BatchList({ initial }: { initial: BatchListResponse | null }) {
  const [batches, setBatches] = useState(initial?.batches ?? []);
  const [cachedAt, setCachedAt] = useState(initial?.cachedAt ?? null);
  const [loadError, setLoadError] = useState(initial === null);

  const refetch = useCallback(async () => {
    try {
      const data = await api.listBatches();
      setBatches(data.batches);
      setCachedAt(data.cachedAt);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  const live = useLiveEvents(api.allEventsUrl(), {
    onConnect: refetch,
    onMessage: (message) => {
      if (message.type !== 'batch.updated') return;
      setBatches((prev) => upsertBatch(prev, message.batch));
    },
  });

  return (
    <section className="card">
      <div className="row between">
        <h2>Batches</h2>
        <span className="muted">
          <LiveIndicator state={live} />
          {cachedAt && <> · list snapshot from {new Date(cachedAt).toLocaleTimeString()} (30s cache), progress is live</>}
        </span>
      </div>
      {loadError && <p className="error">Could not load batches from the API.</p>}
      {batches.length === 0 && !loadError && <p className="muted">No batches yet. Submit some URLs above.</p>}
      {batches.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Batch</th>
                <th>Status</th>
                <th style={{ width: '40%' }}>Progress</th>
                <th>URLs</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link href={`/batches/${b.id}`}>{b.name}</Link>
                    <div className="muted mono small">{b.id}</div>
                  </td>
                  <td>
                    <BatchStatusBadge status={b.status} />
                  </td>
                  <td>
                    <ProgressBar counts={b.counts} compact />
                    <div className="muted small">
                      {b.counts.completed + b.counts.failed + b.counts.cancelled}/{b.counts.total} done
                      {b.counts.failed > 0 && <span className="c-failed"> · {b.counts.failed} failed</span>}
                    </div>
                  </td>
                  <td>{b.counts.total}</td>
                  <td className="muted small">{new Date(b.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
