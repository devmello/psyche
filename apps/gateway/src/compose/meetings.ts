import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { AgentToolRegistry } from "@psyche/agent-core";
import { getLibraryItem, type PsycheDb } from "@psyche/db";
import type { GraphStore } from "@psyche/memory";
import {
  type AudioCapture,
  type CapturedAudio,
  CONFERENCE_APP_BUNDLES,
  CONSENT_LINE,
  type FeedEvent,
  type FeedStore,
  MeetingNotesService,
  MeetingRecorder,
  type MeetingRecording,
  type MeetingTranscriber,
  type NotesOutcome,
  type ProposalService,
  type TheyOweLoop,
} from "@psyche/proactive";
import type {
  Clock,
  GraphLoop,
  LibraryItem,
  MeetingAttendee,
  MeetingNotesResult,
  MeetingRecordingEnded,
  MeetingRecordingStatus,
  ModelProvider,
  ModelRef,
  Notifier,
  RecordingSpeakers,
} from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import type { Logger } from "../log.ts";
import { mountParamsOnly } from "./handlers.ts";
import { ClientAudioCapture } from "./meeting-capture.ts";
import { assertNotesAllowed, notesRefusal, workflowSettings } from "./workflow-settings.ts";

/**
 * Post-meeting notes and "Record meeting" (docs/workflows/mail-and-meetings-2026.md §4.6), and
 * the people graph's side of meeting prep (§4.5). Notes start only from audio the owner chose:
 * a Library recording (`meetings.notes.create`) or a recording started with `meetings.record.start`
 * after the owner confirmed the consent line. The transcript comes from the Mac helper's
 * `speech.transcribe_file`; the summary uses the primary model, and a cloud one only after the
 * owner allowed it once (`meetings.notes.cloudAllowed`, §3 rule 7).
 */

/** The owner's one-time permission to send meeting transcripts to a cloud model. */
export const NOTES_CLOUD_SETTING = "meetings.notes.cloudSummary";

const AUDIO_MIME: Record<string, string> = {
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".caf": "audio/x-caf",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".aac": "audio/aac",
};

export interface MeetingsSetup {
  db: PsycheDb;
  clock: Clock;
  home: string;
  tools: AgentToolRegistry;
  feed: FeedStore;
  notifier: Pick<Notifier, "notify">;
  proposals?: ProposalService;
  provider: ModelProvider;
  /** The summary model (§4.6 step 3); `utility` maps chunks above 60 minutes. */
  primary: ModelRef;
  utility: ModelRef;
  /** Whether `primary` is a cloud model; the composition decides from the router's providers. */
  primaryIsRemote?: () => boolean;
  /**
   * Long-form transcription (the speech part's `meetings`): the Mac helper's
   * `speech.transcribe_file` today; any `PathTranscriber` (a whisper-compatible endpoint on
   * another platform) can stand behind it.
   */
  transcriber?: MeetingTranscriber;
  /**
   * Whether a transcriber can take a recording now. Record meeting is available only then, so
   * the owner is never asked to record audio nothing can turn into notes. Default: always.
   */
  transcriberAvailable?: () => boolean;
  /**
   * Another capture source for Record meeting (a helper microphone); the owner's device captures
   * by default (`meetings.record.push`).
   */
  capture?: () => AudioCapture | undefined;
  /** The people graph while `memory.graph` is on: "they owe you" loops land there. */
  graph?: () => GraphStore | undefined;
  /** The bundle ids of the running apps from the helper, for ending Record meeting on app quit. */
  runningApps?: () => Promise<readonly string[] | undefined>;
  ownerAddresses: () => Promise<string[]>;
  timezone?: string;
  publish(event: "meetings.recording.updated", payload: MeetingRecordingStatus): void;
  onFeedEvent?: (e: FeedEvent) => void;
  logger?: Logger;
}

export interface ComposedMeetings {
  readonly notes: MeetingNotesService;
  readonly record: RecordMeeting;
  readonly handlers: Record<string, HandlerDef>;
  /** A device went away: a recording it was capturing ends and its notes are written. */
  deviceGone(deviceId: string): void;
}

export function composeMeetings(setup: MeetingsSetup): ComposedMeetings {
  const { db, home } = setup;
  const notes = new MeetingNotesService({
    clock: setup.clock,
    tools: setup.tools,
    feed: setup.feed,
    notifier: setup.notifier,
    provider: setup.provider,
    primary: setup.primary,
    utility: setup.utility,
    ownerAddresses: setup.ownerAddresses,
    cloudAllowed: () => workflowSettings(db).notes.cloudSummary,
    readOnly: () => workflowSettings(db).readOnly,
    tasksApp: () => workflowSettings(db).notes.tasksApp,
    recapDraftDefault: () => workflowSettings(db).notes.recapDraft,
    ...(setup.primaryIsRemote === undefined ? {} : { primaryIsRemote: setup.primaryIsRemote }),
    ...(setup.transcriber === undefined ? {} : { transcriber: setup.transcriber }),
    ...(setup.proposals === undefined ? {} : { proposals: setup.proposals }),
    ...(setup.graph === undefined ? {} : { addLoop: graphLoopWriter(setup.graph) }),
    ...(setup.timezone === undefined ? {} : { timezone: setup.timezone }),
    ...(setup.onFeedEvent === undefined ? {} : { onFeedEvent: setup.onFeedEvent }),
    onError: (err) =>
      setup.logger?.log("warn", "meeting notes step failed", { code: PsycheError.from(err).code }),
  });
  const device = new ClientAudioCapture({ db, home, clock: setup.clock });
  const transcriberUp = setup.transcriberAvailable ?? (() => setup.transcriber !== undefined);
  const record = new RecordMeeting({
    notes,
    clock: setup.clock,
    capture: () => setup.capture?.() ?? (transcriberUp() ? device : undefined),
    consentLine: () => workflowSettings(db).notes.consentLine ?? CONSENT_LINE,
    allowed: () => notesRefusal(workflowSettings(db)),
    push: (seq, pcm) => device.push(seq, pcm),
    existingItem: (id) => getLibraryItem(db, id),
    publish: (status) => setup.publish("meetings.recording.updated", status),
    ...(setup.runningApps === undefined ? {} : { runningApps: setup.runningApps }),
    ...(setup.logger === undefined ? {} : { logger: setup.logger }),
  });
  const params = mountParamsOnly({
    "meetings.notes.create": async (p: {
      libraryItemId: string;
      startedAt?: string;
      title?: string;
      speakers?: RecordingSpeakers;
    }): Promise<MeetingNotesResult> => {
      assertNotesAllowed(workflowSettings(db));
      const item = getLibraryItem(db, p.libraryItemId);
      if (item === undefined) {
        throw new PsycheError("not_found", `library item ${p.libraryItemId} not found`);
      }
      if (!/^(audio|video)\//.test(item.mime)) {
        throw new PsycheError("invalid_params", "meeting notes need an audio recording");
      }
      const out = await notes.fromRecording({
        path: join(home, "library", item.path),
        library: { existing: item },
        startedAt: p.startedAt ?? item.createdAt,
        title: p.title ?? basename(item.name, extname(item.name)),
        threadId: item.threadId,
        ...(p.speakers === undefined ? {} : { speakers: p.speakers }),
      });
      return notesResult(out);
    },
  } as never);
  // The recording belongs to the device that started it: only that device pushes audio.
  const byDevice = (fn: (p: never, deviceId: string) => Promise<unknown>): HandlerDef => ({
    run: (call: Call, p: never) => fn(p, call.identity.deviceId),
  });
  const handlers: Record<string, HandlerDef> = {
    ...params,
    "meetings.record.status": { run: async () => record.status() },
    "meetings.record.start": byDevice((p: { consentConfirmed: boolean; meetingId?: string }, d) =>
      record.start(p, d),
    ),
    "meetings.record.push": byDevice(async (p: { seq: number; audio: string }, d) => {
      await record.push(p.seq, Buffer.from(p.audio, "base64"), d);
      return {};
    }),
    "meetings.record.stop": byDevice((p: { reason?: CapturedAudio["reason"] }) =>
      record.stop(p.reason),
    ),
  };
  return { notes, record, handlers, deviceGone: (id) => record.deviceGone(id) };
}

function notesResult(out: NotesOutcome): MeetingNotesResult {
  return out.status === "done"
    ? {
        status: "done",
        postId: out.postId,
        notes: out.notes,
        remindersProposalId: out.remindersProposalId,
      }
    : { status: "needs_permission", question: out.question };
}

interface Active {
  recording: MeetingRecording;
  startedAt: string;
  meetingId: string | null;
  /** The device capturing, when a device does. */
  deviceId: string | null;
  idle?: ReturnType<typeof setTimeout>;
}

/**
 * "Record meeting": one recording at a time, started only after the consent line was confirmed.
 * When it ends (stopped, silence, the conference app quit) its notes are written in the
 * background; each change is published as `meetings.recording.updated`.
 */
export interface RecordMeetingOptions {
  notes: Pick<MeetingNotesService, "fromRecording">;
  clock: Clock;
  capture: () => AudioCapture | undefined;
  /** Takes a chunk of the capturing device's audio (`meetings.record.push`). */
  push?: (seq: number, pcm: Buffer) => Promise<void>;
  /** A capture that already wrote a Library item (`CapturedAudio.itemId`) is notes input as is. */
  existingItem?: (id: string) => LibraryItem | undefined;
  /** Chunks stop for this long and the recording ends (default 2 minutes). */
  idleMs?: number;
  /**
   * The bundle ids of the apps running now, from the helper (`apps.list`); `undefined` when no
   * helper is online. A recording that starts while a conference app runs ends when it quits.
   */
  runningApps?: () => Promise<readonly string[] | undefined>;
  /** How often the conference app is checked (default 5 seconds). */
  appPollMs?: number;
  /** The consent line shown before every start (Settings; default `CONSENT_LINE`). */
  consentLine?: () => string;
  /** Why recording is off right now (paused, notes off), or `undefined` when it may run. */
  allowed?: () => string | undefined;
  publish: (status: MeetingRecordingStatus) => void;
  logger?: Logger;
}

export class RecordMeeting {
  readonly #o: RecordMeetingOptions;
  #active: Active | null = null;
  #last: MeetingRecordingEnded | undefined;
  /** The notes of the last recording, for tests. */
  pending: Promise<void> = Promise.resolve();

  constructor(options: RecordMeetingOptions) {
    this.#o = options;
  }

  status(): MeetingRecordingStatus {
    const a = this.#active;
    return {
      available: this.#o.capture() !== undefined && this.#o.allowed?.() === undefined,
      recording: a !== null,
      consentLine: this.#o.consentLine?.() ?? CONSENT_LINE,
      startedAt: a?.startedAt ?? null,
      meetingId: a?.meetingId ?? null,
      ...(this.#last === undefined ? {} : { last: { ...this.#last } }),
    };
  }

  async start(
    input: { consentConfirmed: boolean; meetingId?: string },
    deviceId?: string,
  ): Promise<MeetingRecordingStatus> {
    if (input.consentConfirmed !== true) {
      throw new PsycheError(
        "forbidden",
        "Recording starts after you confirm you've told everyone (copy the consent line first).",
      );
    }
    if (this.#active !== null) throw new PsycheError("conflict", "a recording is already running");
    const off = this.#o.allowed?.();
    if (off !== undefined) throw new PsycheError("forbidden", off);
    const capture = this.#o.capture();
    if (capture === undefined) {
      throw new PsycheError(
        "unavailable",
        "Record meeting needs a way to turn audio into notes: connect the Mac helper",
        { retryable: true },
      );
    }
    const recording = await new MeetingRecorder({ capture }).start({ consentConfirmed: true });
    this.#active = {
      recording,
      startedAt: new Date(this.#o.clock.now()).toISOString(),
      meetingId: input.meetingId ?? null,
      deviceId: deviceId ?? null,
    };
    this.#watch();
    this.#watchApp(recording).catch(() => undefined);
    // The source ending (silence, the app quit) finishes the recording without a stop call.
    recording.done.then(
      (audio) => this.#ended(recording, audio),
      (err) => this.#failed(recording, err),
    );
    this.#o.publish(this.status());
    return this.status();
  }

  async stop(reason?: CapturedAudio["reason"]): Promise<MeetingRecordingStatus> {
    const active = this.#active;
    if (active === null) throw new PsycheError("conflict", "no recording is running");
    try {
      const audio = await active.recording.stop(reason);
      this.#ended(active.recording, audio);
    } catch (err) {
      // Nothing usable was captured: the recording is over either way.
      this.#failed(active.recording, err);
      throw err;
    }
    return this.status();
  }

  /** One chunk from the capturing device; any other device is refused. */
  async push(seq: number, pcm: Buffer, deviceId?: string): Promise<void> {
    const active = this.#active;
    if (active === null || this.#o.push === undefined) {
      throw new PsycheError("conflict", "no recording is running");
    }
    if (active.deviceId !== null && deviceId !== active.deviceId) {
      throw new PsycheError("forbidden", "this recording is captured by another device");
    }
    await this.#o.push(seq, pcm);
    this.#watch();
  }

  /** The capturing device disconnected: end what was captured so far and write its notes. */
  deviceGone(deviceId: string): void {
    if (this.#active?.deviceId !== deviceId) return;
    this.stop("source_ended").catch(() => undefined);
  }

  /** No chunk for `idleMs` (the device froze, the window closed): the source has ended. */
  #watch(): void {
    const active = this.#active;
    if (active === null) return;
    clearTimeout(active.idle);
    active.idle = setTimeout(() => {
      this.stop("source_ended").catch(() => undefined);
    }, this.#o.idleMs ?? 120_000);
    active.idle.unref?.();
  }

  /**
   * "Record meeting" ends when the conference app quits (§4.6): the conference apps running when
   * the recording starts are checked every few seconds, and when none of them runs any more the
   * capture stops with `app_quit`. With no helper, or no conference app at start, nothing is
   * watched and silence still ends the recording.
   */
  async #watchApp(recording: MeetingRecording): Promise<void> {
    const running = this.#o.runningApps;
    if (running === undefined) return;
    const at = await running();
    const watched = (at ?? []).filter((b) => CONFERENCE_APP_BUNDLES.includes(b));
    const active = this.#active;
    if (watched.length === 0 || active === null || active.recording !== recording) return;
    const timer = setInterval(() => {
      running().then(
        (now) => {
          if (now === undefined || this.#active?.recording !== recording) return;
          if (watched.some((b) => now.includes(b))) return;
          this.stop("app_quit").catch(() => undefined);
        },
        () => undefined,
      );
    }, this.#o.appPollMs ?? 5_000);
    timer.unref?.();
    const clear = () => clearInterval(timer);
    recording.done.then(clear, clear);
  }

  #ended(recording: MeetingRecording, audio: CapturedAudio): void {
    if (this.#active?.recording !== recording) return;
    clearTimeout(this.#active.idle);
    this.#active = null;
    const last: MeetingRecordingEnded = {
      startedAt: audio.startedAt,
      durationMs: Math.max(0, Math.round(audio.durationMs)),
      reason: audio.reason,
      notes: "processing",
    };
    this.#last = last;
    this.#o.publish(this.status());
    this.pending = this.#write(audio, last);
  }

  #failed(recording: MeetingRecording, err: unknown): void {
    if (this.#active?.recording !== recording) return;
    clearTimeout(this.#active.idle);
    this.#active = null;
    this.#o.logger?.log("warn", "meeting recording failed", { code: PsycheError.from(err).code });
    this.#o.publish(this.status());
  }

  async #write(audio: CapturedAudio, last: MeetingRecordingEnded): Promise<void> {
    try {
      const item = audio.itemId === undefined ? undefined : this.#o.existingItem?.(audio.itemId);
      const name = basename(audio.path);
      const out = await this.#o.notes.fromRecording({
        path: audio.path,
        library:
          item !== undefined
            ? { existing: item }
            : {
                audio: {
                  data: new Uint8Array(await readFile(audio.path)),
                  mime: AUDIO_MIME[extname(name).toLowerCase()] ?? "audio/mp4",
                  name,
                },
              },
        startedAt: audio.startedAt,
        durationMs: audio.durationMs,
        ...(item === undefined ? {} : { title: `Meeting ${audio.startedAt.slice(0, 10)}` }),
      });
      last.notes = out.status;
      if (out.status === "done") last.postId = out.postId;
    } catch (err) {
      last.notes = "failed";
      last.error = PsycheError.from(err).message.slice(0, 500);
      this.#o.logger?.log("warn", "meeting notes failed", { code: PsycheError.from(err).code });
    }
    if (this.#last === last) this.#o.publish(this.status());
  }
}

// --- the people graph's side of meetings (§4.5 step 2–3, §4.6 step 3) --------------------------

/** The relationships a prep card shows; other owner-written labels are left to the domain rule. */
const RELATIONSHIPS: Record<string, NonNullable<MeetingAttendee["relationship"]>> = {
  family: "family",
  friend: "friend",
  colleague: "colleague",
  coworker: "colleague",
  "co-worker": "colleague",
  manager: "colleague",
  client: "external",
  customer: "external",
};

/**
 * Meeting prep's graph hooks: each attendee's person (name, one-line summary, the relationship
 * the owner gave) and the open loops with them, both directions. Nothing while the graph is off.
 */
export function graphPrepHooks(graph: () => GraphStore | undefined): {
  person: (email: string) => Promise<Partial<MeetingAttendee> | undefined>;
  loops: (emails: readonly string[]) => Promise<GraphLoop[]>;
} {
  const personId = (g: GraphStore, email: string): string | undefined => {
    const id = g.resolveIdentifier("email", email);
    const e = id === undefined ? undefined : g.getEntity(id);
    return e === undefined || e.kind !== "person" || e.isOwner || e.status !== "active"
      ? undefined
      : e.id;
  };
  return {
    async person(email) {
      const g = graph();
      const id = g === undefined ? undefined : personId(g, email);
      if (g === undefined || id === undefined) return undefined;
      const s = g.summary(id);
      if (s === undefined) return undefined;
      const label = g
        .facts(id)
        .find((f) => f.attribute === "relationship_to_owner")
        ?.value.trim()
        .toLowerCase();
      const relationship = label === undefined ? undefined : RELATIONSHIPS[label];
      const line = s.summary ?? s.subtitle;
      return {
        personId: id,
        name: s.name.slice(0, 200),
        ...(relationship === undefined ? {} : { relationship }),
        ...(line == null || line === "" ? {} : { summary: line.slice(0, 300) }),
      };
    },
    async loops(emails) {
      const g = graph();
      if (g === undefined) return [];
      const ids = new Set<string>();
      for (const email of emails) {
        const id = personId(g, email);
        if (id !== undefined) ids.add(id);
      }
      return [...ids].flatMap((id) => g.loops({ entityId: id, status: ["open"] }));
    },
  };
}

/**
 * "They owe you" loops from meeting notes (§4.6 step 3): the counterpart is the one active person
 * whose name matches; a transcript is other people's words, so the graph keeps such a loop
 * suggested until the owner confirms it.
 */
export function graphLoopWriter(
  graph: () => GraphStore | undefined,
): (loop: TheyOweLoop) => Promise<{ id: string } | undefined> {
  return async (loop) => {
    const g = graph();
    if (g === undefined) return undefined;
    const name = loop.counterpart.trim().toLowerCase();
    const matches = g
      .search(loop.counterpart, { kinds: ["person"], limit: 5 })
      .filter((p) => !p.isOwner && p.name.trim().toLowerCase().startsWith(name));
    const created = g.addLoop({
      direction: "waiting_on",
      text: matches.length === 1 ? loop.text : `${loop.counterpart}: ${loop.text}`,
      evidence: loop.evidence,
      counterpartId: matches.length === 1 ? (matches[0]?.id ?? null) : null,
      dueAt: loop.dueAt,
      status: "open",
      provenance: loop.provenance,
      detectedBy: "model",
    });
    return created === undefined ? undefined : { id: created.id };
  };
}
