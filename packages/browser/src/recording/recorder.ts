import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RecordingFrame, RecordingSink } from "../types.ts";

/**
 * Opt-in per-task screencast recording (feature I10; architecture §8, §12
 * `library/recordings/`). Frames are JPEGs from `Page.startScreencast`; the replay index is a
 * JSON list Activity scrubs through. Frames are dropped while a secure field is active or the
 * page is blocked (the page controller never hands them over). Retention (default 7 days,
 * data model §12) is the Library's job.
 */
export interface ReplayIndexEntry {
  seq: number;
  tabId: string;
  file: string;
  at: number;
  url: string;
}

export interface ReplayIndex {
  taskId: string;
  startedAt: number;
  endedAt?: number;
  frames: ReplayIndexEntry[];
}

export class FileRecordingSink implements RecordingSink {
  readonly dir: string;
  readonly index: ReplayIndex;
  #seq = 0;
  #minIntervalMs: number;
  #lastAt = new Map<string, number>();
  #ready: Promise<unknown>;
  #maxFrames: number;

  /**
   * @param recordingsDir `$PSYCHE_HOME/library/recordings`
   * @param minIntervalMs keep at most one frame per tab per interval (default 250 ms)
   */
  constructor(
    recordingsDir: string,
    taskId: string,
    options: { minIntervalMs?: number; maxFrames?: number } = {},
  ) {
    this.dir = join(recordingsDir, taskId.replace(/[^A-Za-z0-9_-]/g, "_"));
    this.index = { taskId, startedAt: Date.now(), frames: [] };
    this.#minIntervalMs = options.minIntervalMs ?? 250;
    this.#maxFrames = options.maxFrames ?? 20_000;
    this.#ready = mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  async frame(frame: RecordingFrame): Promise<void> {
    const last = this.#lastAt.get(frame.tabId) ?? 0;
    if (frame.at - last < this.#minIntervalMs || this.index.frames.length >= this.#maxFrames)
      return;
    this.#lastAt.set(frame.tabId, frame.at);
    await this.#ready;
    const seq = ++this.#seq;
    const file = `${String(seq).padStart(6, "0")}.jpg`;
    await writeFile(join(this.dir, file), frame.data, { mode: 0o600 });
    // URLs can carry tokens in queries; the index keeps origin and path only.
    let url = frame.url;
    try {
      const u = new URL(frame.url);
      url = `${u.origin}${u.pathname}`;
    } catch {
      // keep as is
    }
    this.index.frames.push({ seq, tabId: frame.tabId, file, at: frame.at, url });
  }

  async close(): Promise<void> {
    await this.#ready;
    this.index.endedAt = Date.now();
    await writeFile(join(this.dir, "index.json"), JSON.stringify(this.index, null, 2), {
      mode: 0o600,
    });
  }
}
