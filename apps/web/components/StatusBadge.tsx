import { BATCH_STATUS_LABELS, CHECK_STATUS_LABELS, type BatchStatus, type CheckStatus } from '@uhc/shared';

export function CheckStatusBadge({ status, attempts }: { status: CheckStatus; attempts?: number }) {
  const retrying = status === 'queued' && (attempts ?? 0) > 0;
  return (
    <span className={`badge badge-${status}`} title={retrying ? `Retrying (attempt ${attempts! + 1})` : undefined}>
      {retrying ? `Retrying (${attempts})` : CHECK_STATUS_LABELS[status]}
    </span>
  );
}

export function BatchStatusBadge({ status }: { status: BatchStatus }) {
  return <span className={`badge badge-${status}`}>{BATCH_STATUS_LABELS[status]}</span>;
}

export function LiveIndicator({ state }: { state: 'connecting' | 'live' | 'reconnecting' }) {
  const label = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Reconnecting';
  return <span className={`live live-${state}`}>● {label}</span>;
}
