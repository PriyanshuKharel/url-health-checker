/** Tracks in-flight checks per batch so a cancel can abort them immediately. */
export class InflightRegistry {
  private readonly byBatch = new Map<string, Set<AbortController>>();

  register(batchId: string, controller: AbortController): void {
    let set = this.byBatch.get(batchId);
    if (!set) {
      set = new Set();
      this.byBatch.set(batchId, set);
    }
    set.add(controller);
  }

  unregister(batchId: string, controller: AbortController): void {
    const set = this.byBatch.get(batchId);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) this.byBatch.delete(batchId);
  }

  /** @returns how many in-flight checks were aborted. */
  abortAll(batchId: string): number {
    const set = this.byBatch.get(batchId);
    if (!set) return 0;
    for (const controller of set) controller.abort(new Error('Batch cancelled'));
    return set.size;
  }

  get size(): number {
    let n = 0;
    for (const set of this.byBatch.values()) n += set.size;
    return n;
  }
}
