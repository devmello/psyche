import { basename, extname } from "node:path";
import type { Automation, Clock } from "@psyche/protocol";
import { ulid } from "ulid";
import type { FeedEvent } from "../feed/service.ts";
import type { FeedStore, StoredPost } from "../feed/store.ts";
import {
  jobMarker,
  type LaunchRequest,
  type LaunchResult,
  type ProactiveJob,
  parseJobMarker,
  type SchedulerLike,
} from "../jobs.ts";
import type { ProposalService } from "../proposals/service.ts";
import { toIso } from "../sqlite.ts";

/**
 * The recordings-folder watch (docs/workflows/mail-and-meetings-2026.md §4.6; #953). When
 * `meetings.notes.folder` is set to a granted folder, a scan every five minutes looks for audio
 * files that appeared after the watch was turned on. Each one is copied into the Library and
 * offered once as a Feed card whose single approval runs `meetings.notes.create` on the copy.
 * Nothing is transcribed, summarized or sent before that approval.
 *
 * Choices:
 * - The first scan of a folder path is a baseline: every file already there is marked seen and
 *   none is offered. Changing the path (or turning the watch off and on) sets a new baseline.
 * - Only the folder's top level is read, and only audio extensions the notes path accepts.
 * - A file is offered after two scans saw the same size and modification time, so a recording
 *   still being written (or still syncing) is left alone.
 * - Seen names persist in the scheduler's `event_cursors`, so a restart offers nothing twice.
 */

export const NOTES_FOLDER_JOB = "notes-folder";
export const NOTES_FOLDER_SCHEDULE = "PT5M";
export const NOTES_FOLDER_SOURCE = "meetings.notes.folder";
/** The tool a proposal calls; the Gateway registers it behind `meetings.notes.create`. */
export const NOTES_CREATE_TOOL = "meetings.notes.create";
/** Audio the notes path accepts. `.mp4` is left out: it is usually video. */
export const NOTES_AUDIO_EXTENSIONS: readonly string[] = [".m4a", ".mp3", ".wav", ".aac", ".caf"];

const STATE_KEY = "state";
/** Seen names kept per watch; the oldest drop first. */
const MAX_SEEN = 5000;
/** At most this many offers per scan; the rest wait for the next. */
const MAX_OFFERS_PER_SCAN = 5;
/** A file whose copy keeps failing is given up after this many scans. */
const MAX_COPY_FAILURES = 3;
/** Recordings over this size are not copied. */
export const MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024;
/** An offer waits a week for its approval. */
const OFFER_TTL_MS = 7 * 24 * 3_600_000;

/** One regular file at the top of the folder. */
export interface FolderFile {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

/** The scheduler's cursor store (`SqliteScheduler` fits). */
export interface CursorStore {
  getCursor(source: string, key: string): string | undefined;
  setCursor(source: string, key: string, cursor: string): void;
}

interface Pending {
  size: number;
  mtimeMs: number;
  failures: number;
}

interface WatchState {
  folder: string;
  seen: string[];
  pending: Record<string, Pending>;
}

export interface NotesFolderOptions {
  clock: Clock;
  cursors: CursorStore;
  feed: FeedStore;
  proposals: Pick<ProposalService, "create">;
  /** `meetings.notes.folder` from Settings; empty = the watch is off. */
  folder: () => string | undefined;
  /** Why notes are off right now (Settings), or `undefined` when they may run. */
  refusal?: () => string | undefined;
  /** Whether the folder lies in a granted folder (read access). Not granted = no scan. */
  granted: (folder: string) => boolean;
  /** The regular files at the folder's top level. */
  list: (folder: string) => Promise<readonly FolderFile[]>;
  /** Copies one file into the Library and returns the new item's id. */
  copy: (file: FolderFile) => Promise<{ libraryItemId: string }>;
  onFeedEvent?: (e: FeedEvent) => void;
  newId?: () => string;
  onError?: (error: unknown) => void;
  /** Called once per folder when the scan cannot run, with the reason. */
  onSkip?: (reason: string) => void;
}

export interface NotesFolderScan {
  offered: number;
  skipped?: string;
  baseline?: number;
}

const isAudio = (name: string): boolean =>
  !name.startsWith(".") && NOTES_AUDIO_EXTENSIONS.includes(extname(name).toLowerCase());

export class NotesFolderWatcher {
  readonly #o: NotesFolderOptions;
  #told: string | undefined;

  constructor(options: NotesFolderOptions) {
    this.#o = options;
  }

  /** The system automation that runs the scan (interval, `[psyche:notes-folder scan]`). */
  async ensureSchedule(
    scheduler: SchedulerLike,
    options: { enabled?: boolean; timezone?: string } = {},
  ): Promise<Automation> {
    const prompt = jobMarker(NOTES_FOLDER_JOB, "scan");
    const fields = {
      title: "Check the recordings folder",
      schedule: NOTES_FOLDER_SCHEDULE,
      timezone: options.timezone ?? "UTC",
      sessionTarget: "main",
      delivery: {},
      prompt,
      enabled: options.enabled ?? true,
      scratch: null,
    };
    const existing = (await scheduler.list()).find((a) => a.prompt.trim() === prompt);
    return existing === undefined
      ? scheduler.create({ kind: "interval", system: true, ...fields })
      : scheduler.update(existing.id, fields);
  }

  #load(): WatchState | undefined {
    const raw = this.#o.cursors.getCursor(NOTES_FOLDER_SOURCE, STATE_KEY);
    if (raw === undefined || raw === "") return undefined;
    try {
      const s = JSON.parse(raw) as Partial<WatchState>;
      if (typeof s.folder !== "string" || !Array.isArray(s.seen)) return undefined;
      return {
        folder: s.folder,
        seen: s.seen.filter((n): n is string => typeof n === "string"),
        pending: s.pending !== null && typeof s.pending === "object" ? s.pending : {},
      };
    } catch {
      return undefined;
    }
  }

  #save(state: WatchState): void {
    const seen = state.seen.length > MAX_SEEN ? state.seen.slice(-MAX_SEEN) : state.seen;
    this.#o.cursors.setCursor(NOTES_FOLDER_SOURCE, STATE_KEY, JSON.stringify({ ...state, seen }));
  }

  /** The watch is off: forget the baseline so turning it on again starts from now. */
  #reset(): void {
    if (this.#load() !== undefined) this.#o.cursors.setCursor(NOTES_FOLDER_SOURCE, STATE_KEY, "");
    this.#told = undefined;
  }

  #skip(reason: string, key: string): NotesFolderScan {
    if (this.#told !== key) {
      this.#told = key;
      this.#o.onSkip?.(reason);
    }
    return { offered: 0, skipped: reason };
  }

  async scan(): Promise<NotesFolderScan> {
    const refusal = this.#o.refusal?.();
    if (refusal !== undefined) {
      this.#reset();
      return { offered: 0, skipped: refusal };
    }
    const folder = this.#o.folder()?.trim();
    if (folder === undefined || folder === "") {
      this.#reset();
      return { offered: 0, skipped: "no recordings folder is set" };
    }
    if (!this.#o.granted(folder)) {
      return this.#skip("the recordings folder is not a granted folder", `ungranted:${folder}`);
    }
    this.#told = undefined;

    const files = (await this.#o.list(folder)).filter((f) => isAudio(f.name));
    const state = this.#load();
    if (state === undefined || state.folder !== folder) {
      // The baseline: what is there now is not offered.
      this.#save({ folder, seen: files.map((f) => f.name), pending: {} });
      return { offered: 0, baseline: files.length };
    }

    const seen = new Set(state.seen);
    const pending: Record<string, Pending> = {};
    let offered = 0;
    for (const file of files) {
      if (seen.has(file.name)) continue;
      const before = state.pending[file.name];
      const stable =
        before !== undefined &&
        before.size === file.size &&
        before.mtimeMs === file.mtimeMs &&
        file.size > 0;
      if (!stable || offered >= MAX_OFFERS_PER_SCAN) {
        // Seen for the first time, or still changing: look again next scan.
        const same = before?.size === file.size && before.mtimeMs === file.mtimeMs;
        pending[file.name] = {
          size: file.size,
          mtimeMs: file.mtimeMs,
          failures: same ? (before?.failures ?? 0) : 0,
        };
        continue;
      }
      let item: { libraryItemId: string } | undefined;
      if (file.size > MAX_RECORDING_BYTES) {
        seen.add(file.name);
        continue;
      }
      try {
        item = await this.#o.copy(file);
      } catch (err) {
        this.#o.onError?.(err);
        const failures = (before?.failures ?? 0) + 1;
        if (failures >= MAX_COPY_FAILURES) seen.add(file.name);
        else pending[file.name] = { size: file.size, mtimeMs: file.mtimeMs, failures };
        continue;
      }
      // Marked seen before the card exists: a crash costs one offer, never a repeat.
      seen.add(file.name);
      this.#save({ folder, seen: [...seen], pending });
      try {
        this.#offer(file, item.libraryItemId);
        offered += 1;
      } catch (err) {
        this.#o.onError?.(err);
      }
    }
    this.#save({ folder, seen: [...seen], pending });
    return { offered };
  }

  #offer(file: FolderFile, libraryItemId: string): void {
    const now = this.#o.clock.now();
    const postId = this.#o.newId?.() ?? `post_${ulid(now)}`;
    const title = basename(file.name, extname(file.name)).slice(0, 200) || file.name.slice(0, 200);
    const proposal = this.#o.proposals.create({
      title: `Make meeting notes from ${file.name}`.slice(0, 200),
      calls: [
        {
          tool: NOTES_CREATE_TOOL,
          params: { libraryItemId, title },
          summary: `Make meeting notes from ${file.name}`.slice(0, 200),
        },
      ],
      createdBy: { job: "meetings.notes.folder" },
      postId,
      ttlMs: OFFER_TTL_MS,
    });
    const post: StoredPost = {
      id: postId,
      title: `New recording: ${file.name}`.slice(0, 200),
      bodyMd: [
        `A new recording, **${file.name}**, appeared in your recordings folder. Psyche copied it into your Library.`,
        "",
        "Make meeting notes from it? Nothing is transcribed or summarized until you approve.",
      ].join("\n"),
      citations: [],
      cluster: null,
      score: 1,
      reasons: ["new recording"],
      exploration: false,
      briefingId: null,
      feedback: null,
      createdAt: toIso(now),
      batchId: postId,
      kind: "suggestion",
      refs: { proposalIds: [proposal.id] },
    };
    this.#o.feed.insert(post);
    const { batchId: _b, readAt: _r, ...wire } = post;
    this.#o.onFeedEvent?.({ event: "feed.updated", payload: { posts: [wire] } });
  }

  /** The in-process job behind the scan automation (`withProactiveJobs`). */
  job(): ProactiveJob {
    return {
      name: "recordings folder",
      matches: (a) => parseJobMarker(a.prompt)?.job === NOTES_FOLDER_JOB,
      run: async (_request: LaunchRequest): Promise<LaunchResult> => {
        try {
          const r = await this.scan();
          return {
            status: "no_reply",
            summary:
              r.skipped !== undefined
                ? `skipped: ${r.skipped}`
                : r.baseline !== undefined
                  ? `watching (${r.baseline} existing)`
                  : `${r.offered} offered`,
          };
        } catch (err) {
          this.#o.onError?.(err);
          return { status: "failed", summary: "scan failed" };
        }
      },
    };
  }
}
