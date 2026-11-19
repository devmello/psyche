/**
 * Screenshot frames as data URLs, bounded by bytes (least recently used goes first) and released
 * when no run view is mounted for the run. A scrubbed computer-use run used to keep every frame
 * it had shown until reload.
 */
export class FrameCache {
  private readonly map = new Map<string, string>();
  private readonly holders = new Map<string, number>();
  private bytes = 0;

  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get size(): number {
    return this.map.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  get(key: string): string | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: string): void {
    const old = this.map.get(key);
    if (old !== undefined) {
      this.bytes -= old.length;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += value.length;
    // Always keep the newest entry, even when it alone is over budget.
    for (const k of [...this.map.keys()]) {
      if (this.bytes <= this.maxBytes || this.map.size <= 1) break;
      this.drop(k);
    }
  }

  /** Whether a view of the run is mounted; a load that finishes after it closed is dropped. */
  holds(runId: string): boolean {
    return (this.holders.get(runId) ?? 0) > 0;
  }

  /** A run view mounted. Pair with `release`. */
  retain(runId: string): void {
    this.holders.set(runId, (this.holders.get(runId) ?? 0) + 1);
  }

  /** A run view unmounted; the run's frames are dropped when the last one goes. */
  release(runId: string): void {
    const n = (this.holders.get(runId) ?? 0) - 1;
    if (n > 0) {
      this.holders.set(runId, n);
      return;
    }
    this.holders.delete(runId);
    const prefix = `${runId}/`;
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.drop(k);
  }

  clear(): void {
    this.map.clear();
    this.holders.clear();
    this.bytes = 0;
  }

  private drop(key: string): void {
    const v = this.map.get(key);
    if (v === undefined) return;
    this.bytes -= v.length;
    this.map.delete(key);
  }
}

/** About 24 MB of base64 text: a few dozen full frames, or a few hundred thumbnails. */
export const frameCache = new FrameCache(24 * 1024 * 1024);
