import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { AgentToolRegistry } from "@psyche/agent-core";
import { getLibraryItem, getSetting, type PsycheDb } from "@psyche/db";
import type { GraphStore } from "@psyche/memory";
import {
  type AudioCapture,
  type CapturedAudio,
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
import type { Logger } from "../log.ts";
import { mountParamsOnly } from "./handlers.ts";

/**
 * Post-meeting notes and "Record meeting" (docs/workflows/mail-and-meetings-2026.md §4.6), and
 * the people graph's side of meeting prep (§4.5). Notes start only from audio the owner chose:
 * a Library recording (`meetings.notes.create`) or a recording started with `meetings.record.start`
 * after the owner confirmed the consent line. The transcript comes from the Mac helper's
 * `speech.transcribe_file`; the summary uses the primary model, and a cloud one only after the
 * owner allowed it once (`meetings.notes.cloudAllowed`, §3 rule 7).
 */

/** The owner's one-time permission to send meeting transcripts to a cloud model. */
export const NOTES_CLOUD_SETTING = "meetings.notes.cloudAllowed";

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
  /** The Mac helper's long-form transcription (the speech part's `meetings`). */
  transcriber?: MeetingTranscriber;
  /** The helper microphone for Record meeting; unavailable while it returns `undefined`. */
  capture?: () => AudioCapture | undefined;
  /** The people graph while `memory.graph` is on: "they owe you" loops land there. */
  graph?: () => GraphStore | undefined;
  ownerAddresses: () => Promise<string[]>;
  timezone?: string;
  publish(event: "meetings.recording.updated", payload: MeetingRecordingStatus): void;
  onFeedEvent?: (e: FeedEvent) => void;
  logger?: Logger;
}

export interface ComposedMeetings {
  readonly notes: MeetingNotesService;
  readonly record: RecordMeeting;
  readonly handlers: ReturnType<typeof mountParamsOnly>;
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
    cloudAllowed: () => getSetting(db, NOTES_CLOUD_SETTING)?.value === true,
    ...(setup.primaryIsRemote === undefined ? {} : { primaryIsRemote: setup.primaryIsRemote }),
    ...(setup.transcriber === undefined ? {} : { transcriber: setup.transcriber }),
    ...(setup.proposals === undefined ? {} : { proposals: setup.proposals }),
    ...(setup.graph === undefined ? {} : { addLoop: graphLoopWriter(setup.graph) }),
    ...(setup.timezone === undefined ? {} : { timezone: setup.timezone }),
    ...(setup.onFeedEvent === undefined ? {} : { onFeedEvent: setup.onFeedEvent }),
    onError: (err) =>
      setup.logger?.log("warn", "meeting notes step failed", { code: PsycheError.from(err).code }),
  });
  const record = new RecordMeeting({
    notes,
    clock: setup.clock,
    capture: setup.capture ?? (() => undefined),
    publish: (status) => setup.publish("meetings.recording.updated", status),
    ...(setup.logger === undefined ? {} : { logger: setup.logger }),
  });
  const handlers = mountParamsOnly({
    "meetings.notes.create": async (p: {
      libraryItemId: string;
      startedAt?: string;
      title?: string;
      speakers?: RecordingSpeakers;
    }): Promise<MeetingNotesResult> => {
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
    "meetings.record.status": async () => record.status(),
    "meetings.record.start": (p: { consentConfirmed: boolean; meetingId?: string }) =>
      record.start(p),
    "meetings.record.stop": () => record.stop(),
  } as never);
  return { notes, record, handlers };
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
      available: this.#o.capture() !== undefined,
      recording: a !== null,
      consentLine: CONSENT_LINE,
      startedAt: a?.startedAt ?? null,
      meetingId: a?.meetingId ?? null,
      ...(this.#last === undefined ? {} : { last: { ...this.#last } }),
    };
  }

  async start(input: {
    consentConfirmed: boolean;
    meetingId?: string;
  }): Promise<MeetingRecordingStatus> {
    if (input.consentConfirmed !== true) {
      throw new PsycheError(
        "forbidden",
        "Recording starts after you confirm you've told everyone (copy the consent line first).",
      );
    }
    if (this.#active !== null) throw new PsycheError("conflict", "a recording is already running");
    const capture = this.#o.capture();
    if (capture === undefined) {
      throw new PsycheError("unavailable", "Record meeting needs the Mac helper's microphone", {
        retryable: true,
      });
    }
    const recording = await new MeetingRecorder({ capture }).start({ consentConfirmed: true });
    this.#active = {
      recording,
      startedAt: new Date(this.#o.clock.now()).toISOString(),
      meetingId: input.meetingId ?? null,
    };
    // The source ending (silence, the app quit) finishes the recording without a stop call.
    recording.done.then(
      (audio) => this.#ended(recording, audio),
      (err) => this.#failed(recording, err),
    );
    this.#o.publish(this.status());
    return this.status();
  }

  async stop(): Promise<MeetingRecordingStatus> {
    const active = this.#active;
    if (active === null) throw new PsycheError("conflict", "no recording is running");
    const audio = await active.recording.stop();
    this.#ended(active.recording, audio);
    return this.status();
  }

  #ended(recording: MeetingRecording, audio: CapturedAudio): void {
    if (this.#active?.recording !== recording) return;
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
    this.#active = null;
    this.#o.logger?.log("warn", "meeting recording failed", { code: PsycheError.from(err).code });
    this.#o.publish(this.status());
  }

  async #write(audio: CapturedAudio, last: MeetingRecordingEnded): Promise<void> {
    try {
      const data = await readFile(audio.path);
      const name = basename(audio.path);
      const out = await this.#o.notes.fromRecording({
        path: audio.path,
        library: {
          audio: {
            data: new Uint8Array(data),
            mime: AUDIO_MIME[extname(name).toLowerCase()] ?? "audio/mp4",
            name,
          },
        },
        startedAt: audio.startedAt,
        durationMs: audio.durationMs,
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
