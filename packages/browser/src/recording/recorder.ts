import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserRecordingEventKind } from "@psyche/protocol";
import type { RecordingFrame, RecordingSink } from "../types.ts";

/**
 * Opt-in per-task recording (feature I10; architecture §8, §12 `library/recordings/`). A
 * recording is a directory with JPEG frames from `Page.startScreencast`, one text file per
 * recorded snapshot, and `index.json`, the replay index Activity scrubs through: the frame
 * list plus an event log of what the agent did (navigations, snapshots, actions, fills,
 * downloads, blocks, control changes, dialogs).
 *
 * Redaction happens here, at write time, and the drivers never hand this sink a secret:
 * - frames while a secure field is active, after a fill or on a blocked page are never sent
 *   (the page controller drops them, as it does screenshots);
 * - URLs keep origin and path only (query strings carry tokens);
 * - snapshot text is what the model saw (secure fields masked, `redact` applied);
 * - a credential fill records the placeholder and the element, never a value, and typed text
 *   goes through `redact` and is capped.
 *
 * Retention (default 7 days, data model §12) is `RecordingStore.prune`.
 */
export const RECORDING_INDEX_VERSION = 2;

export interface ReplayIndexEntry {
  seq: number;
  tabId: string;
  file: string;
  /** Epoch milliseconds. */
  at: number;
  url: string;
}

export interface ReplayEvent {
  seq: number;
  /** Epoch milliseconds. */
  at: number;
  tabId: string;
  kind: BrowserRecordingEventKind;
  summary: string;
  url?: string;
  action?: string;
  ref?: string;
  element?: { role: string; name: string };
  detail?: Record<string, unknown>;
  /** `snapshot` events: the text file (`s000001.txt`) holding what the model saw. */
  snapshotFile?: string;
  /** The latest frame at or before `at`. */
  frameSeq?: number;
}

export interface ReplayIndex {
  version: number;
  /** The recording id: the task id, or `thread:<id>` for chat turns. */
  id: string;
  taskId: string | null;
  threadId: string | null;
  startedAt: number;
  endedAt?: number;
  frames: ReplayIndexEntry[];
  events: ReplayEvent[];
}

/** What a driver records; the sink adds `seq`, `at` and `frameSeq`. */
export interface RecordingEventInput {
  tabId: string;
  kind: BrowserRecordingEventKind;
  summary: string;
  url?: string;
  action?: string;
  ref?: string;
  element?: { role: string; name: string };
  detail?: Record<string, unknown>;
  /** `snapshot` events: the model-visible text; written to its own file. */
  snapshotText?: string;
}

/** Origin and path only: query strings and fragments carry tokens. */
export function redactRecordedUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** Directory name for a recording id (`thread:abc` → `thread_abc`). */
export function recordingDirName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

export interface FileRecordingSinkOptions {
  /** Keep at most one frame per tab per interval (default 250 ms). */
  minIntervalMs?: number;
  maxFrames?: number;
  maxEvents?: number;
  /** Snapshot text cap per event (default 64 kB). */
  maxSnapshotChars?: number;
  taskId?: string;
  threadId?: string;
  /** Post-fill hygiene for typed text (`CredentialBroker.redact`). */
  redact?: (text: string) => string;
  /** Called after each change (debounced); the composition publishes `browser.recording.updated`. */
  onChange?: (index: ReplayIndex) => void;
}

export class FileRecordingSink implements RecordingSink {
  readonly dir: string;
  readonly index: ReplayIndex;
  #seq = 0;
  #eventSeq = 0;
  #snapSeq = 0;
  #o: FileRecordingSinkOptions;
  #lastAt = new Map<string, number>();
  #ready: Promise<unknown>;
  #writes: Promise<unknown> = Promise.resolve();
  #flushTimer: NodeJS.Timeout | undefined;
  #closed = false;

  /**
   * @param recordingsDir `$PSYCHE_HOME/library/recordings`
   * @param id the task id, or `thread:<id>` for chat turns
   */
  constructor(recordingsDir: string, id: string, options: FileRecordingSinkOptions = {}) {
    this.dir = join(recordingsDir, recordingDirName(id));
    this.#o = options;
    this.index = {
      version: RECORDING_INDEX_VERSION,
      id,
      taskId: options.taskId ?? null,
      threadId: options.threadId ?? null,
      startedAt: Date.now(),
      frames: [],
      events: [],
    };
    this.#ready = mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  get closed(): boolean {
    return this.#closed;
  }

  async frame(frame: RecordingFrame): Promise<void> {
    const last = this.#lastAt.get(frame.tabId) ?? 0;
    const maxFrames = this.#o.maxFrames ?? 20_000;
    if (frame.at - last < (this.#o.minIntervalMs ?? 250) || this.index.frames.length >= maxFrames)
      return;
    this.#lastAt.set(frame.tabId, frame.at);
    await this.#ready;
    const seq = ++this.#seq;
    const file = `${String(seq).padStart(6, "0")}.jpg`;
    await this.#write(file, frame.data);
    this.index.frames.push({
      seq,
      tabId: frame.tabId,
      file,
      at: frame.at,
      url: redactRecordedUrl(frame.url),
    });
    this.#changed();
  }

  async event(input: RecordingEventInput): Promise<void> {
    if (this.index.events.length >= (this.#o.maxEvents ?? 50_000)) return;
    await this.#ready;
    const at = Date.now();
    const e: ReplayEvent = {
      seq: ++this.#eventSeq,
      at,
      tabId: input.tabId,
      kind: input.kind,
      // Summaries quote page text (dialog messages, element names): same masking as details.
      summary: (this.#o.redact ?? ((t: string) => t))(input.summary).slice(0, 500),
    };
    if (input.url !== undefined) e.url = redactRecordedUrl(input.url);
    if (input.action !== undefined) e.action = input.action;
    if (input.ref !== undefined) e.ref = input.ref;
    if (input.element !== undefined) e.element = input.element;
    if (input.detail !== undefined) e.detail = this.#redactDetail(input.detail);
    const lastFrame = this.index.frames.at(-1);
    if (lastFrame !== undefined) e.frameSeq = lastFrame.seq;
    if (input.snapshotText !== undefined) {
      const file = `s${String(++this.#snapSeq).padStart(6, "0")}.txt`;
      const text = (this.#o.redact ?? ((s) => s))(input.snapshotText).slice(
        0,
        this.#o.maxSnapshotChars ?? 65_536,
      );
      await this.#write(file, text);
      e.snapshotFile = file;
    }
    this.index.events.push(e);
    this.#changed();
  }

  #redactDetail(detail: Record<string, unknown>): Record<string, unknown> {
    const redact = this.#o.redact ?? ((s: string) => s);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(detail)) {
      out[k] = typeof v === "string" ? redact(v).slice(0, 500) : v;
    }
    return out;
  }

  #write(file: string, data: Uint8Array | string): Promise<void> {
    const next = this.#writes.then(() => writeFile(join(this.dir, file), data, { mode: 0o600 }));
    this.#writes = next.catch(() => undefined);
    return next;
  }

  /** Index writes are debounced so a burst of frames costs one file write. */
  #changed(): void {
    this.#o.onChange?.(this.index);
    if (this.#flushTimer !== undefined) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      // A recording deleted or moved underneath a pending flush is not an error worth raising.
      void this.flush().catch(() => undefined);
    }, 250);
    this.#flushTimer.unref?.();
  }

  #cancelFlush(): void {
    if (this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
  }

  async flush(): Promise<void> {
    await this.#ready;
    await this.#write("index.json", JSON.stringify(this.index, null, 2));
  }

  /** Writes the index. Only `end()` marks the recording finished. */
  async close(): Promise<void> {
    this.#cancelFlush();
    await this.flush();
  }

  /** The session is over: stamp `endedAt` and write the final index. */
  async end(): Promise<ReplayIndex> {
    this.#cancelFlush();
    if (!this.#closed) {
      this.#closed = true;
      this.index.endedAt = Date.now();
    }
    await this.flush();
    this.#o.onChange?.(this.index);
    return this.index;
  }
}
