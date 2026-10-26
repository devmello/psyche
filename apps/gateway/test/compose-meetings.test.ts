import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@psyche/agent-core";
import { getLibraryItem, insertLibraryItem, setSetting } from "@psyche/db";
import type { AudioCapture, CapturedAudio } from "@psyche/proactive";
import type {
  MeetingRecordingStatus,
  ModelEvent,
  ModelRequest,
  TranscriptSegment,
} from "@psyche/protocol";
import type { PathTranscribeOptions, PathTranscriber, PathTranscript } from "@psyche/speech";
import { VoiceMemoService } from "@psyche/speech";
import { FakeClock, FakeModelProvider, FakeSpeechEngine } from "@psyche/testing";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { ClientAudioCapture } from "../src/compose/meeting-capture.ts";
import { composeMeetings, graphPrepHooks, RecordMeeting } from "../src/compose/meetings.ts";
import { GRAPH_SETTING } from "../src/compose/people.ts";
import { FsAudioLibrary, libraryTranscripts } from "../src/compose/speech.ts";
import type { HandlerDef } from "../src/context.ts";
import { silentLogger } from "../src/log.ts";

/**
 * Post-meeting notes, Record meeting and graph-aware prep in the Gateway
 * (docs/workflows/mail-and-meetings-2026.md §4.5, §4.6; #670), on a fake speech engine.
 */

const NOW = Date.parse("2026-10-26T12:00:00Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

let home = "";
let composed: ComposedGateway | null = null;

afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

function say(text: string): ModelEvent[] {
  return [
    { type: "text_delta", text },
    {
      type: "usage",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
    },
    { type: "finish", reason: "stop" },
  ];
}

const clock = () => new FakeClock(NOW);

async function compose(provider = new FakeModelProvider()): Promise<ComposedGateway> {
  home = mkdtempSync(join(tmpdir(), "psyche-meetings-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    timeZone: "UTC",
    clock: clock(),
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider, model: "fake/model" },
  });
  return composed;
}

function enableGraph(c: ComposedGateway) {
  setSetting(c.db, GRAPH_SETTING, { enabled: true });
  c.people.sync({ enabled: true });
}

const run = (h: HandlerDef | undefined, params: unknown, deviceId = "dev1") => {
  if (h === undefined) throw new Error("handler not mounted");
  return (h.run as (call: unknown, p: unknown) => Promise<unknown>)(
    { identity: { deviceId } },
    params,
  );
};

const LINES = [
  "Let's go over the pilot",
  "We agreed the pilot starts on November third",
  "I'll book the kickoff with their IT team",
  "Dana will share the security questionnaire",
];

function segments(minutes: number): TranscriptSegment[] {
  const step = (minutes * MIN) / LINES.length;
  return LINES.map((text, i) => ({
    text,
    startMs: Math.round(i * step),
    endMs: Math.round(i * step + 20_000),
    final: true,
  }));
}

/** The helper's `speech.transcribe_file`, faked: progress per 10 minutes, then the transcript. */
class FakeFiles implements PathTranscriber {
  readonly paths: string[] = [];
  readonly progress: number[] = [];
  readonly minutes: number;
  constructor(minutes: number) {
    this.minutes = minutes;
  }
  async transcribePath(path: string, options: PathTranscribeOptions = {}): Promise<PathTranscript> {
    this.paths.push(path);
    const total = this.minutes * MIN;
    for (let ms = 10 * MIN; ms <= total; ms += 10 * MIN) {
      options.onProgress?.({
        type: "speech.progress",
        processedMs: ms,
        totalMs: total,
        fraction: ms / total,
        chunk: ms / (10 * MIN),
        chunks: Math.ceil(total / (10 * MIN)),
      } as never);
      this.progress.push(ms);
    }
    const segs = segments(this.minutes);
    return {
      text: segs.map((s) => s.text).join(" "),
      segments: segs,
      audioMs: total,
      engine: "fake",
      chunks: Math.ceil(total / (10 * MIN)),
    };
  }
}

const NOTES = {
  summary: ["Pilot dates agreed", "Kickoff and security review next"],
  decisions: [
    { text: "Pilot starts November 3", quote: "the pilot starts on November third", at: "5:00" },
  ],
  actionItems: [
    { text: "Book the kickoff with IT", owner: "I", due: null, quote: "I'll book the kickoff" },
    {
      text: "Share the security questionnaire",
      owner: "Dana",
      due: null,
      quote: "Dana will share the security questionnaire",
    },
  ],
  openQuestions: [],
};

/** The notes pipeline as the Gateway composes it, with the speech side on fakes. */
function notesRig(c: ComposedGateway, provider: FakeModelProvider, minutes = 40) {
  c.loop.registry.register(
    defineTool({
      name: "reminders_create",
      description: "Create a reminder",
      input: Type.Object({}, { additionalProperties: true }),
      sideEffect: "write",
      run: async () => ({ output: { id: "r1" }, provenance: "trusted" }),
    }),
  );
  const prompts: ModelRequest[] = [];
  for (let i = 0; i < 4; i += 1) {
    provider.enqueue((r: ModelRequest) => {
      prompts.push(r);
      return say(JSON.stringify(NOTES));
    });
  }
  const files = new FakeFiles(minutes);
  const memos = new VoiceMemoService({
    engine: new FakeSpeechEngine(),
    library: new FsAudioLibrary(home, undefined, (item) => {
      insertLibraryItem(c.db, item);
    }),
    files,
  });
  const transcripts = libraryTranscripts(c.db, home);
  const published: MeetingRecordingStatus[] = [];
  let capture: AudioCapture | undefined;
  const meetings = composeMeetings({
    db: c.db,
    clock: clock(),
    home,
    tools: c.loop.registry,
    feed: c.proactive.feed.store,
    notifier: c.notifier,
    ...(c.proactive.proposals === undefined ? {} : { proposals: c.proactive.proposals }),
    provider,
    primary: "fake/primary",
    utility: "fake/utility",
    transcriber: { ingestMeeting: (input) => memos.ingestMeeting(input as never, transcripts) },
    transcriberAvailable: () => true,
    capture: () => capture,
    graph: () => (c.people.settings().enabled ? c.people.graph : undefined),
    ownerAddresses: async () => ["sam@acme.example"],
    timezone: "UTC",
    publish: (_event, status) => published.push(status),
  });
  return {
    meetings,
    files,
    prompts,
    published,
    setCapture: (cap: AudioCapture | undefined) => {
      capture = cap;
    },
  };
}

/** A microphone that "records" to a file and ends when the test says (silence, the app quit). */
function fakeCapture(path: string) {
  let end: (a: CapturedAudio) => void = () => {};
  let starts = 0;
  const capture: AudioCapture = {
    async start() {
      starts += 1;
      writeFileSync(path, new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
      const ended = new Promise<CapturedAudio>((resolve) => {
        end = resolve;
      });
      return {
        ended,
        stop: async () => {
          const a: CapturedAudio = {
            path,
            startedAt: iso(NOW),
            durationMs: 30 * MIN,
            reason: "stopped",
          };
          end(a);
          return a;
        },
      };
    },
  };
  return {
    capture,
    starts: () => starts,
    sourceEnds: (reason: CapturedAudio["reason"]) =>
      end({ path, startedAt: iso(NOW), durationMs: 30 * MIN, reason }),
  };
}

describe("post-meeting notes in the Gateway (§4.6)", () => {
  it("mounts meetings.* and reports Record meeting unavailable without a helper microphone", async () => {
    const c = await compose();
    for (const m of [
      "meetings.notes.create",
      "meetings.record.status",
      "meetings.record.start",
      "meetings.record.stop",
    ]) {
      expect(Object.keys(c.proactive.handlers)).toContain(m);
    }
    const status = (await run(
      c.proactive.handlers["meetings.record.status"],
      {},
    )) as MeetingRecordingStatus;
    expect(status).toMatchObject({ available: false, recording: false, startedAt: null });
    expect(status.consentLine).toMatch(/recording this meeting/);
    await expect(
      run(c.proactive.handlers["meetings.record.start"], { consentConfirmed: true }),
    ).rejects.toMatchObject({ code: "unavailable" });
    // No helper is connected: a Library recording cannot be transcribed yet, and says so.
    const item = insertLibraryItem(c.db, {
      kind: "audio",
      name: "Kickoff.m4a",
      mime: "audio/mp4",
      path: "audio/kickoff.m4a",
      size: 8,
      sha256: "sha256:00",
      origin: "upload",
    });
    await expect(
      run(c.proactive.handlers["meetings.notes.create"], { libraryItemId: item.id }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("writes notes from a Library recording end to end: transcript extract, post, reminders card, graph loop", async () => {
    const provider = new FakeModelProvider();
    const c = await compose(provider);
    enableGraph(c);
    const dana = c.people.graph.createEntity({
      kind: "person",
      name: "Dana Park",
      identifiers: [{ kind: "email", value: "dana@client.example" }],
    });
    const r = notesRig(c, provider, 40);
    const item = insertLibraryItem(c.db, {
      kind: "audio",
      name: "Acme kickoff.m4a",
      mime: "audio/mp4",
      path: "audio/acme.m4a",
      size: 8,
      sha256: "sha256:00",
      origin: "upload",
      createdAt: iso(NOW - 45 * MIN),
    });
    const out = (await run(r.meetings.handlers["meetings.notes.create"], {
      libraryItemId: item.id,
    })) as { status: string; postId: string; remindersProposalId: string | null };

    // Transcribed on the "Mac" where the file lies, in 10-minute steps.
    expect(r.files.paths).toEqual([join(home, "library", "audio/acme.m4a")]);
    expect(r.files.progress).toEqual([10, 20, 30, 40].map((m) => m * MIN));
    expect(r.prompts[0]?.model).toBe("fake/primary");
    // The transcript is the item's text extract; other people's words quarantine it.
    const stored = getLibraryItem(c.db, item.id);
    expect(stored?.textExtractRef).toBe(`extracts/${item.id}.txt`);
    expect(stored?.quarantined).toBe(true);
    expect(readFileSync(join(home, "library", `extracts/${item.id}.txt`), "utf8")).toMatch(
      /pilot starts on November third/,
    );

    expect(out.status).toBe("done");
    const post = c.proactive.feed.store.get(out.postId);
    expect(post?.kind).toBe("meeting_notes");
    expect(post?.title).toBe("Notes: Acme kickoff · 11:15");
    const card = post?.card as { type: string; notes: { actionItems: { loopId?: string }[] } };
    // The owner's item is one reminders card; Dana's is a "they owe you" loop on her person.
    expect(out.remindersProposalId).not.toBeNull();
    const proposal = await c.proactive.proposals?.get(out.remindersProposalId ?? "");
    expect(proposal?.calls.map((x) => x.tool)).toEqual(["reminders_create"]);
    const loops = c.people.graph.loops({ entityId: dana.id, status: ["open", "suggested"] });
    expect(loops.map((l) => [l.direction, l.text, l.status, l.provenance])).toEqual([
      ["waiting_on", "Share the security questionnaire", "suggested", "untrusted"],
    ]);
    expect(card.notes.actionItems.map((a) => a.loopId)).toEqual([undefined, loops[0]?.id]);
    // One notification for the notes.
    const kinds = (await c.notifier.list()).map((n) => n.title);
    expect(kinds).toContain("Notes ready: Acme kickoff · 11:15");
  });

  it("Record meeting: refused before consent, then the source ending writes the notes", async () => {
    const provider = new FakeModelProvider();
    const c = await compose(provider);
    const r = notesRig(c, provider, 30);
    const mic = fakeCapture(join(home, "Meeting 2026-10-26.m4a"));
    r.setCapture(mic.capture);

    expect(r.meetings.record.status()).toMatchObject({ available: true, recording: false });
    await expect(
      run(r.meetings.handlers["meetings.record.start"], { consentConfirmed: false }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(mic.starts()).toBe(0);

    const started = (await run(r.meetings.handlers["meetings.record.start"], {
      consentConfirmed: true,
      meetingId: "ev1",
    })) as MeetingRecordingStatus;
    expect(started).toMatchObject({ recording: true, meetingId: "ev1", startedAt: iso(NOW) });
    await expect(r.meetings.record.start({ consentConfirmed: true })).rejects.toMatchObject({
      code: "conflict",
    });

    // Five minutes of silence: the capture ends by itself, and the notes follow.
    mic.sourceEnds("silence");
    await new Promise((resolve) => setImmediate(resolve));
    await r.meetings.record.pending;
    const last = r.meetings.record.status().last;
    expect(last).toMatchObject({ reason: "silence", notes: "done", durationMs: 30 * MIN });
    expect(r.published.map((s) => [s.recording, s.last?.notes])).toEqual([
      [true, undefined],
      [false, "processing"],
      [false, "done"],
    ]);
    const post = c.proactive.feed.store.get(last?.postId ?? "");
    expect(post?.title).toBe("Notes: Meeting 2026-10-26 · 12:00");
    // The recording was saved to the Library with its transcript beside it.
    const recId =
      (post?.card as { notes: { recordingItemId: string } } | undefined)?.notes.recordingItemId ??
      "";
    const rec = getLibraryItem(c.db, recId);
    expect(rec).toMatchObject({ kind: "recording", quarantined: true });
    expect(existsSync(join(home, "library", rec?.textExtractRef ?? "none"))).toBe(true);

    // Stop with nothing running is a conflict, not a silent success.
    await expect(r.meetings.record.stop()).rejects.toMatchObject({ code: "conflict" });
  });

  it("Record meeting: stop ends the recording once and asks for cloud permission when needed", async () => {
    const provider = new FakeModelProvider();
    const c = await compose(provider);
    const r = notesRig(c, provider, 20);
    const mic = fakeCapture(join(home, "standup.m4a"));
    r.setCapture(mic.capture);
    await r.meetings.record.start({ consentConfirmed: true });
    const stopped = await r.meetings.record.stop();
    expect(stopped).toMatchObject({ recording: false, last: { reason: "stopped" } });
    await r.meetings.record.pending;
    expect(r.meetings.record.status().last?.notes).toBe("done");
    // Exactly one notes run for one recording.
    expect(r.prompts).toHaveLength(1);
  });
});

/** One second of 16 kHz mono PCM s16le, as a device's microphone chunk. */
const pcmChunk = (seconds = 1) => Buffer.alloc(32_000 * seconds, 1).toString("base64");

describe("Record meeting with the device's microphone (§4.6)", () => {
  const call = (r: ReturnType<typeof notesRig>, name: string, params: unknown, device = "dev1") =>
    run(r.meetings.handlers[name], params, device);

  it("is available once a transcriber is online, and asks consent before it takes any audio", async () => {
    const provider = new FakeModelProvider();
    const c = await compose(provider);
    const r = notesRig(c, provider, 20);
    expect(r.meetings.record.status()).toMatchObject({ available: true, recording: false });
    await expect(
      call(r, "meetings.record.start", { consentConfirmed: false }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      call(r, "meetings.record.push", { seq: 0, audio: pcmChunk() }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("stores the pushed audio as a Library WAV and writes notes from it where it lies", async () => {
    const provider = new FakeModelProvider();
    const c = await compose(provider);
    const r = notesRig(c, provider, 20);
    await call(r, "meetings.record.start", { consentConfirmed: true, meetingId: "ev1" });
    // Only the device that started the recording pushes; chunks go in order.
    await expect(
      call(r, "meetings.record.push", { seq: 0, audio: pcmChunk() }, "dev2"),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await call(r, "meetings.record.push", { seq: 0, audio: pcmChunk() });
    await expect(
      call(r, "meetings.record.push", { seq: 2, audio: pcmChunk() }),
    ).rejects.toMatchObject({
      code: "invalid_params",
    });
    await call(r, "meetings.record.push", { seq: 1, audio: pcmChunk() });
    const stopped = (await call(r, "meetings.record.stop", {
      reason: "silence",
    })) as MeetingRecordingStatus;
    expect(stopped).toMatchObject({
      recording: false,
      last: { reason: "silence", durationMs: 2000 },
    });
    await r.meetings.record.pending;
    const last = r.meetings.record.status().last;
    expect(last).toMatchObject({ notes: "done", reason: "silence" });

    const [path] = r.files.paths;
    expect(path).toMatch(/library\/audio\/[0-9A-Z]+\.wav$/);
    const wav = readFileSync(path ?? "");
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(40)).toBe(64_000);
    expect(wav.length).toBe(44 + 64_000);
    const id = (path ?? "").split("/").pop()?.replace(".wav", "") ?? "";
    expect(getLibraryItem(c.db, id)).toMatchObject({
      kind: "recording",
      mime: "audio/wav",
      quarantined: true,
      textExtractRef: `extracts/${id}.txt`,
    });
    const post = c.proactive.feed.store.get(last?.postId ?? "");
    expect(post?.title).toMatch(/^Notes: Meeting 2026-10-26/);
  });

  it("ends the recording and keeps its notes when the device disconnects", async () => {
    const provider = new FakeModelProvider();
    const c = await compose(provider);
    const r = notesRig(c, provider, 20);
    await call(r, "meetings.record.start", { consentConfirmed: true });
    await call(r, "meetings.record.push", { seq: 0, audio: pcmChunk() });
    r.meetings.deviceGone("dev2");
    expect(r.meetings.record.status().recording).toBe(true);
    r.meetings.deviceGone("dev1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await r.meetings.record.pending;
    expect(r.meetings.record.status()).toMatchObject({
      recording: false,
      last: { reason: "source_ended", notes: "done" },
    });
  });

  it("a recording with no audio ends without notes instead of hanging", async () => {
    const provider = new FakeModelProvider();
    const c = await compose(provider);
    const r = notesRig(c, provider, 20);
    await call(r, "meetings.record.start", { consentConfirmed: true });
    await expect(call(r, "meetings.record.stop", {})).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(r.meetings.record.status().recording).toBe(false);
    await call(r, "meetings.record.start", { consentConfirmed: true });
  });

  it("ends by itself when chunks stop, and at the 4-hour cap", async () => {
    const provider = new FakeModelProvider();
    const c = await compose(provider);
    const r = notesRig(c, provider, 20);
    const mic = new ClientAudioCapture({ db: c.db, home, clock: clock() });
    const idle = new RecordMeeting({
      notes: { fromRecording: async () => ({ status: "needs_permission", question: "ok?" }) },
      clock: clock(),
      capture: () => mic,
      push: (seq, pcm) => mic.push(seq, pcm),
      idleMs: 25,
      publish: () => {},
    });
    await idle.start({ consentConfirmed: true }, "dev1");
    await idle.push(0, Buffer.alloc(32_000, 1), "dev1");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(idle.status().last).toMatchObject({ reason: "source_ended" });

    const capped = new ClientAudioCapture({ db: c.db, home, clock: clock(), maxMs: 1000 });
    const session = await capped.start();
    await capped.push(0, Buffer.alloc(64_000, 1));
    const audio = await session.ended;
    expect(audio).toMatchObject({ reason: "stopped", durationMs: 1000 });
    expect(r.prompts).toHaveLength(0);
  });
});

describe("graph-aware meeting prep (§4.5)", () => {
  const EVENT = {
    id: "e1",
    title: "Dana / Sam",
    start: iso(NOW + 3 * 60 * MIN),
    end: iso(NOW + 3.5 * 60 * MIN),
    attendees: [
      { name: "Sam", email: "sam@acme.example", status: "accepted", organizer: true },
      { name: "", email: "Dana@Client.example", status: "accepted", organizer: false },
    ],
  };

  async function prepRig(graphOn: boolean) {
    const provider = new FakeModelProvider();
    provider.enqueue(() => say(JSON.stringify({ why: "Pilot follow-up", agenda: [] })));
    const c = await compose(provider);
    setSetting(c.db, "mail.ownerAddresses", ["sam@acme.example"]);
    c.loop.registry.register(
      defineTool({
        name: "calendar_list_events",
        description: "List events",
        input: Type.Object({}, { additionalProperties: true }),
        sideEffect: "none",
        run: async () => ({ output: { events: [EVENT] }, provenance: "untrusted" }),
      }),
    );
    if (graphOn) enableGraph(c);
    const graph = c.people.graph;
    const dana = graph.createEntity({
      kind: "person",
      name: "Dana Park",
      identifiers: [{ kind: "email", value: "dana@client.example" }],
    });
    graph.setFact({
      entityId: dana.id,
      attribute: "relationship_to_owner",
      value: "Client",
      provenance: "owner",
      source: { kind: "owner_edit" },
    });
    graph.addLoop({
      direction: "i_owe",
      text: "Send Dana the revised quote",
      counterpartId: dana.id,
      status: "open",
      provenance: "owner",
      detectedBy: "owner",
    });
    graph.addLoop({
      direction: "waiting_on",
      text: "Dana to sign the NDA",
      counterpartId: dana.id,
      status: "open",
      provenance: "owner",
      detectedBy: "owner",
    });
    return { c, dana };
  }

  it("passes the graph's person and open loops into the prep note", async () => {
    const { c, dana } = await prepRig(true);
    const prep = c.proactive.meetingPrep;
    await prep?.plan();
    const note = await prep?.prepare("e1");
    expect(note?.attendees).toEqual([
      {
        email: "dana@client.example",
        name: "Dana Park",
        personId: dana.id,
        relationship: "external",
      },
    ]);
    expect(note?.openLoops.map((l) => [l.direction, l.text])).toEqual([
      ["i_owe", "Send Dana the revised quote"],
      ["waiting_on", "Dana to sign the NDA"],
    ]);
    const post = c.proactive.feed.store.list().posts.find((p) => p.kind === "meeting_prep");
    expect(post?.bodyMd).toMatch(/You owe: Send Dana the revised quote/);
    expect(post?.bodyMd).toMatch(/Waiting on: Dana to sign the NDA/);
  });

  it("reads nothing from the graph while it is off", async () => {
    const { c } = await prepRig(false);
    await c.proactive.meetingPrep?.plan();
    const note = await c.proactive.meetingPrep?.prepare("e1");
    expect(note?.attendees[0]?.personId).toBeUndefined();
    expect(note?.openLoops).toEqual([]);
    const hooks = graphPrepHooks(() => undefined);
    expect(await hooks.person("dana@client.example")).toBeUndefined();
    expect(await hooks.loops(["dana@client.example"])).toEqual([]);
  });
});
