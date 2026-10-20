import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type BrowserRecording,
  type BrowserRecordingEvent,
  type BrowserRecordingFrame,
  PsycheError,
} from "@psyche/protocol";
import {
  type FileRecordingSink,
  RECORDING_INDEX_VERSION,
  type ReplayIndex,
  recordingDirName,
} from "./recorder.ts";

/**
 * Reads recordings back for the `browser.recordings.*` client methods (feature I10). A live
 * recording is read from its sink's in-memory index; a finished one from `index.json`. Frame
 * and snapshot files are read by sequence number only, never by a client-supplied path.
 */
export interface RecordingStoreOptions {
  /** A live sink for an id, when one exists. */
  live?: (id: string) => FileRecordingSink | undefined;
  /** Library item ids for imported recordings. */
  libraryItemId?: (id: string) => string | undefined;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class RecordingStore {
  readonly dir: string;
  #o: RecordingStoreOptions;

  /** @param recordingsDir `$PSYCHE_HOME/library/recordings` */
  constructor(recordingsDir: string, options: RecordingStoreOptions = {}) {
    this.dir = recordingsDir;
    this.#o = options;
  }

  async #index(id: string): Promise<ReplayIndex> {
    const live = this.#o.live?.(id);
    if (live !== undefined) return live.index;
    let raw: string;
    try {
      raw = await readFile(join(this.dir, recordingDirName(id), "index.json"), "utf8");
    } catch {
      throw new PsycheError("not_found", `recording ${id} not found`);
    }
    const index = JSON.parse(raw) as Partial<ReplayIndex>;
    // v1 indexes (frames only) are still readable.
    return {
      version: index.version ?? 1,
      id: index.id ?? id,
      taskId: index.taskId ?? null,
      threadId: index.threadId ?? null,
      startedAt: index.startedAt ?? 0,
      ...(index.endedAt === undefined ? {} : { endedAt: index.endedAt }),
      frames: index.frames ?? [],
      events: index.events ?? [],
    };
  }

  async #bytes(id: string): Promise<number> {
    const dir = join(this.dir, recordingDirName(id));
    let total = 0;
    try {
      for (const name of await readdir(dir)) {
        total += (await stat(join(dir, name))).size;
      }
    } catch {
      // not on disk yet
    }
    return total;
  }

  async #summary(index: ReplayIndex): Promise<BrowserRecording> {
    return {
      id: index.id,
      taskId: index.taskId,
      threadId: index.threadId,
      startedAt: iso(index.startedAt),
      endedAt: index.endedAt === undefined ? null : iso(index.endedAt),
      frameCount: index.frames.length,
      eventCount: index.events.length,
      bytes: await this.#bytes(index.id),
      libraryItemId: this.#o.libraryItemId?.(index.id) ?? null,
    };
  }

  /** Summary of one recording (for `browser.recording.updated`). */
  async summary(id: string): Promise<BrowserRecording> {
    return this.#summary(await this.#index(id));
  }

  async list(filter: { taskId?: string; threadId?: string } = {}): Promise<BrowserRecording[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      names = [];
    }
    const out: BrowserRecording[] = [];
    for (const name of names) {
      let index: ReplayIndex;
      try {
        const raw = await readFile(join(this.dir, name, "index.json"), "utf8");
        const parsed = JSON.parse(raw) as Partial<ReplayIndex>;
        index = await this.#index(parsed.id ?? name);
      } catch {
        continue;
      }
      if (filter.taskId !== undefined && index.taskId !== filter.taskId) continue;
      if (filter.threadId !== undefined && index.threadId !== filter.threadId) continue;
      out.push(await this.#summary(index));
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async get(
    id: string,
    options: { sinceSeq?: number; limit?: number } = {},
  ): Promise<{
    recording: BrowserRecording;
    events: BrowserRecordingEvent[];
    frames: BrowserRecordingFrame[];
  }> {
    const index = await this.#index(id);
    const since = options.sinceSeq ?? 0;
    const limit = options.limit ?? 5000;
    const events = index.events
      .filter((e) => e.seq > since)
      .slice(0, limit)
      .map((e): BrowserRecordingEvent => {
        const out: BrowserRecordingEvent = {
          seq: e.seq,
          at: iso(e.at),
          tabId: e.tabId,
          kind: e.kind,
          summary: e.summary,
        };
        if (e.url !== undefined) out.url = e.url;
        if (e.action !== undefined) out.action = e.action;
        if (e.ref !== undefined) out.ref = e.ref;
        if (e.element !== undefined) out.element = e.element;
        if (e.detail !== undefined) out.detail = e.detail;
        if (e.snapshotFile !== undefined) out.snapshotSeq = e.seq;
        if (e.frameSeq !== undefined) out.frameSeq = e.frameSeq;
        return out;
      });
    const frames = index.frames
      .filter((f) => f.seq > since)
      .slice(0, limit)
      .map(
        (f): BrowserRecordingFrame => ({
          seq: f.seq,
          at: iso(f.at),
          tabId: f.tabId,
          url: f.url,
        }),
      );
    return { recording: await this.#summary(index), events, frames };
  }

  async frame(
    id: string,
    seq: number,
  ): Promise<{ frame: BrowserRecordingFrame; mime: "image/jpeg"; data: string }> {
    const index = await this.#index(id);
    const f = index.frames.find((x) => x.seq === seq);
    if (f === undefined) throw new PsycheError("not_found", `frame ${seq} not found`);
    const data = await readFile(join(this.dir, recordingDirName(id), f.file));
    return {
      frame: { seq: f.seq, at: iso(f.at), tabId: f.tabId, url: f.url },
      mime: "image/jpeg",
      data: data.toString("base64"),
    };
  }

  /** The text a `snapshot` event recorded (untrusted page content). */
  async snapshot(id: string, seq: number): Promise<{ text: string }> {
    const index = await this.#index(id);
    const file = index.events.find((x) => x.seq === seq)?.snapshotFile;
    if (file === undefined) {
      throw new PsycheError("not_found", `event ${seq} has no snapshot`);
    }
    const text = await readFile(join(this.dir, recordingDirName(id), file), "utf8");
    return { text };
  }

  async delete(id: string): Promise<void> {
    if (this.#o.live?.(id) !== undefined) {
      throw new PsycheError("conflict", `recording ${id} is still being written`);
    }
    await this.#index(id);
    await rm(join(this.dir, recordingDirName(id)), { recursive: true, force: true });
  }

  /** Retention (data model §12): delete finished recordings older than `maxAgeMs`. */
  async prune(maxAgeMs: number, now = Date.now()): Promise<string[]> {
    const removed: string[] = [];
    for (const r of await this.list()) {
      const endedAt = r.endedAt;
      if (typeof endedAt !== "string" || this.#o.live?.(r.id) !== undefined) continue;
      if (now - Date.parse(endedAt) > maxAgeMs) {
        await rm(join(this.dir, recordingDirName(r.id)), { recursive: true, force: true });
        removed.push(r.id);
      }
    }
    return removed;
  }
}

export { RECORDING_INDEX_VERSION };
