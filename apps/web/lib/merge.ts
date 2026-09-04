import type { BatchSummary, UrlCheck } from '@uhc/shared';

function done(b: BatchSummary): number {
  return b.counts.completed + b.counts.failed + b.counts.cancelled;
}

/**
 * Decide whether an incoming batch summary should replace the one we hold.
 * State changes bump updatedAt; progress events keep it but move counts forward.
 * Out-of-order progress events (two workers finishing at once) are therefore dropped.
 */
export function newerBatch(prev: BatchSummary, next: BatchSummary): boolean {
  if (next.updatedAt > prev.updatedAt) return true;
  if (next.updatedAt < prev.updatedAt) return false;
  return done(next) >= done(prev);
}

/** A check event is applied only if it belongs to the same or a newer run and is not older. */
export function newerCheck(prev: UrlCheck, next: UrlCheck): boolean {
  if (next.run !== prev.run) return next.run > prev.run;
  return next.updatedAt >= prev.updatedAt;
}

export function upsertBatch(list: BatchSummary[], incoming: BatchSummary): BatchSummary[] {
  const idx = list.findIndex((b) => b.id === incoming.id);
  if (idx === -1) return [incoming, ...list];
  const prev = list[idx]!;
  if (!newerBatch(prev, incoming)) return list;
  const copy = list.slice();
  copy[idx] = incoming;
  return copy;
}
