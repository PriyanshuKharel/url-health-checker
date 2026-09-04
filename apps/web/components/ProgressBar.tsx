import { progressPercent, type BatchCounts } from '@uhc/shared';

export function ProgressBar({ counts, compact = false }: { counts: BatchCounts; compact?: boolean }) {
  const pct = progressPercent(counts);
  const seg = (n: number) => (counts.total ? `${(n / counts.total) * 100}%` : '0%');
  return (
    <div className={compact ? 'progress compact' : 'progress'}>
      <div className="progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="seg seg-completed" style={{ width: seg(counts.completed) }} />
        <div className="seg seg-failed" style={{ width: seg(counts.failed) }} />
        <div className="seg seg-cancelled" style={{ width: seg(counts.cancelled) }} />
        <div className="seg seg-running" style={{ width: seg(counts.running) }} />
      </div>
      {!compact && (
        <div className="progress-meta">
          <strong>{pct}%</strong> · {counts.completed + counts.failed + counts.cancelled} of {counts.total} done ·{' '}
          <span className="c-completed">{counts.completed} completed</span> ·{' '}
          <span className="c-failed">{counts.failed} failed</span> · <span className="c-running">{counts.running} running</span> ·{' '}
          <span>{counts.queued} queued</span>
          {counts.cancelled > 0 && <> · <span className="c-cancelled">{counts.cancelled} cancelled</span></>}
        </div>
      )}
    </div>
  );
}
