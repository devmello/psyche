import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, openDb, setSetting } from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import {
  conversationSettings,
  migrateRetiredVoices,
  voiceApprovals,
} from "../src/compose/speech.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNode, type FakeNodeHandler } from "./fake-node.ts";
import { desktopClient, newDeviceKey, type TestClient } from "./helpers.ts";

let composed: ComposedGateway | null = null;
let home = "";
const clients: TestClient[] = [];
let helper: FakeNode | null = null;

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await helper?.close();
  helper = null;
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const read = (name: string, streaming = false) => ({
  name,
  sideEffect: "read" as const,
  streaming,
});

/**
 * A Mac helper shaped like apps/mac-helper: `speech.transcribe_stream` (source push) announces
 * the stream, `speech.audio_push` reports partials and finishes on `final`, `speech.voices` lists
 * system voices.
 */
function speechHelper(): FakeNodeHandler[] {
  const streams = new Map<
    string,
    { bytes: number; emit: (d: unknown) => void; done: (r: unknown) => void }
  >();
  let n = 0;
  return [
    {
      capability: read("speech.transcribe_stream", true),
      run: (_params, emit) =>
        new Promise((done) => {
          const streamId = `st_${++n}`;
          streams.set(streamId, { bytes: 0, emit, done });
          emit({ type: "speech.started", streamId, engine: "speechAnalyzer" });
        }),
    },
    {
      capability: read("speech.audio_push"),
      run: (params) => {
        const p = params as { streamId: string; data: string; final?: boolean };
        const s = streams.get(p.streamId);
        if (!s) throw new Error("unknown stream");
        const bytes = Buffer.from(p.data, "base64").byteLength;
        s.bytes += bytes;
        if (p.final === true) {
          const text = `heard ${s.bytes} bytes`;
          s.emit({ type: "speech.final", text, startMs: 0, endMs: 100, final: true });
          s.done({
            streamId: p.streamId,
            text,
            segments: [{ text, startMs: 0, endMs: 100, final: true }],
            engine: "speechAnalyzer",
            language: "en-US",
          });
        }
        return { accepted: bytes, bufferedBytes: 0, final: p.final === true };
      },
    },
    { capability: read("speech.stop"), run: () => ({ ok: true }) },
    { capability: read("speech.synthesize", true), run: () => ({}) },
    {
      capability: read("speech.voices"),
      run: () => ({
        voices: [{ id: "com.apple.voice.Ava", name: "Ava", language: "en-US", quality: "premium" }],
        personalVoiceAuthorization: "notDetermined",
      }),
    },
    { capability: read("speech.status"), run: () => ({ ready: true }) },
  ];
}

async function setup(): Promise<ComposedGateway> {
  home = mkdtempSync(join(tmpdir(), "psyche-speech-"));
  composed = await composeGateway({
    env: {},
    logger: silentLogger,
    retentionIntervalMs: 0,
    background: false,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
    model: { provider: new FakeModelProvider(), model: "fake/model" },
  });
  return composed;
}

describe("speech over the wire (S17 handlers mounted by the Gateway)", () => {
  it("answers speech.voices without a helper, then lists the helper's voices", async () => {
    const c = await setup();
    const desk = await desktopClient(c.gateway);
    clients.push(desk);
    const before = await desk.call<{ voices: { id: string }[]; unavailable: string[] }>(
      "speech.voices",
      {},
    );
    expect(before.voices.some((v) => v.id === "com.apple.voice.Ava")).toBe(false);

    helper = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
      origin: c.gateway.origin,
      secret: c.gateway.handshakeSecret,
      handlers: speechHelper(),
    });
    const after = await desk.call<{ voices: { id: string; location: string }[] }>(
      "speech.voices",
      {},
    );
    expect(after.voices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "com.apple.voice.Ava", location: "node" }),
      ]),
    );
  });

  it("dictates through the helper and sends segments only to the dictating device", async () => {
    const c = await setup();
    helper = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
      origin: c.gateway.origin,
      secret: c.gateway.handshakeSecret,
      handlers: speechHelper(),
    });
    const desk = await desktopClient(c.gateway, newDeviceKey(), "desk-a");
    const other = await desktopClient(c.gateway, newDeviceKey(), "desk-b");
    clients.push(desk, other);

    const started = await desk.call<{ sessionId: string; location: string }>("voice.start", {
      format: { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 },
    });
    expect(started).toMatchObject({ location: "node" });
    await desk.call("voice.push", {
      sessionId: started.sessionId,
      seq: 0,
      audio: Buffer.alloc(3200).toString("base64"),
    });
    const stopped = await desk.call<{ transcript: { text: string } }>("voice.stop", {
      sessionId: started.sessionId,
    });
    expect(stopped.transcript.text).toMatch(/^heard \d+ bytes$/);
    await desk.waitForEvent((e) => String(e.event).startsWith("voice."));
    expect(other.events.filter((e) => String(e.event).startsWith("voice."))).toEqual([]);
    // Another device cannot drive this device's session.
    expect((await other.request("voice.stop", { sessionId: started.sessionId })).ok).toBe(false);
  });

  it("ends a device's dictation sessions when its last connection closes", async () => {
    const c = await setup();
    helper = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
      origin: c.gateway.origin,
      secret: c.gateway.handshakeSecret,
      handlers: speechHelper(),
    });
    const key = newDeviceKey();
    const first = await desktopClient(c.gateway, key, "desk-c");
    const started = await first.call<{ sessionId: string }>("voice.start", {
      format: { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 },
    });
    first.close();
    await new Promise((r) => first.ws.once("close", r));
    await new Promise((r) => setTimeout(r, 20));
    const again = await desktopClient(c.gateway, key, "desk-c");
    clients.push(again);
    const push = await again.request("voice.push", {
      sessionId: started.sessionId,
      seq: 0,
      audio: Buffer.alloc(320).toString("base64"),
    });
    expect(push.ok).toBe(false);
  });
});

describe("voice conversation over the wire (V-G, docs/voice/voice-mode-2026.md)", () => {
  it("refuses while Settings has it off, then starts on the helper's engine and stops", async () => {
    const c = await setup();
    helper = await FakeNode.connect(c.gateway.config.nodeSocketPath, {
      origin: c.gateway.origin,
      secret: c.gateway.handshakeSecret,
      handlers: speechHelper(),
    });
    const desk = await desktopClient(c.gateway);
    clients.push(desk);
    const params = {
      mode: "push",
      format: { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 },
    };
    const off = await desk.request("voice.conversation.start", params);
    expect(off.ok).toBe(false);
    expect((off as { error?: { code: string } }).error?.code).toBe("policy_denied");

    setSetting(c.gateway.context.db, "voice.conversation.enabled", true);
    const started = await desk.call<{ conversationId: string; location: string; engine: string }>(
      "voice.conversation.start",
      params,
    );
    expect(started).toMatchObject({ location: "node", engine: "mac-node" });
    const state = await desk.waitForEvent((e) => e.event === "voice.conversation.state");
    expect(state.payload).toMatchObject({
      conversationId: started.conversationId,
      phase: "listening",
      listening: false,
    });
    expect(
      await desk.call("voice.conversation.stop", { conversationId: started.conversationId }),
    ).toEqual({ ok: true });
    const ended = await desk.waitForEvent((e) => e.event === "voice.conversation.ended");
    expect(ended.payload).toEqual({ conversationId: started.conversationId, reason: "stopped" });
  });

  it("reads the owner's speak, narrate and pause settings, clamped", () => {
    const values: Record<string, unknown> = {
      "voice.conversation.speak": "full",
      "voice.conversation.narrate": "steps",
      "voice.conversation.pauseMs": 9_000,
    };
    expect(conversationSettings((k) => values[k])).toEqual({
      speak: "full",
      narrate: "steps",
      pauseMs: 2_000,
    });
    expect(conversationSettings(() => "nonsense")).toEqual({});
  });
});

describe("the retired OpenAI voice (#691)", () => {
  it("moves an owner who picked it to the default voice once, with a notice", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-voice-migrate-"));
    const db = openDb(join(home, "psyche.db"));
    const notices: { title: string; dedupeKey?: string; route?: string }[] = [];
    const notifier = {
      notify: async (n: { title: string; dedupeKey?: string; route?: string }) => {
        notices.push(n);
      },
    } as never;
    try {
      setSetting(db, "voice.conversation.voice", "openai:marin");
      setSetting(db, "speech.tts.voice", "mac-node:com.apple.voice.premium.en-US.Ava");
      expect(migrateRetiredVoices({ db, notifier })).toEqual(["voice.conversation.voice"]);
      expect(getSetting(db, "voice.conversation.voice")?.value).toBeNull();
      expect(getSetting(db, "speech.tts.voice")?.value).toBe(
        "mac-node:com.apple.voice.premium.en-US.Ava",
      );
      expect(notices).toEqual([
        expect.objectContaining({
          route: "/settings/voice",
          dedupeKey: "speech:voice-retired:openai",
        }),
      ]);
      // Already migrated: nothing to write and no second notice.
      expect(migrateRetiredVoices({ db, notifier })).toEqual([]);
      expect(notices).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("approvals answered by voice (voiceApprovals)", () => {
  it("answers as this device's surface with scope once and via voice, and refuses without a card", async () => {
    const c = await setup();
    const desk = await desktopClient(c.gateway, newDeviceKey(), "dev_voice_desk");
    clients.push(desk);
    const answered: unknown[] = [];
    const services = {
      db: c.gateway.context.db,
      approvalTokens: {
        tokenFor: (approvalId: string, surface: string) =>
          approvalId === "apr_1" && surface === "desktop" ? "tok_desktop" : undefined,
      },
      rawBroker: {
        answer: async (input: unknown) => {
          answered.push(input);
          return { status: "approved" };
        },
      },
    } as unknown as Parameters<typeof voiceApprovals>[0];
    const port = voiceApprovals(services);
    await port.answer({
      approvalId: "apr_1",
      deviceId: "dev_voice_desk",
      decision: "approve",
      utterance: "yes send it",
    });
    expect(answered).toEqual([
      {
        approvalId: "apr_1",
        answerToken: "tok_desktop",
        decision: "approve",
        scope: "once",
        via: "voice",
        decidedBy: { deviceId: "dev_voice_desk", surface: "desktop" },
      },
    ]);
    await expect(
      port.answer({
        approvalId: "apr_2",
        deviceId: "dev_voice_desk",
        decision: "approve",
        utterance: "yes",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
