import type { MeetingRecordingStatus } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  CHUNK_SAMPLES,
  MeetingRecorderClient,
  SILENCE_STOP_MS,
} from "../../src/shell/meeting-record.ts";
import type { AudioSource } from "../../src/shell/voice.ts";

const LINE = "Quick note: I'm recording this meeting.";
const status = (over: Partial<MeetingRecordingStatus> = {}): MeetingRecordingStatus => ({
  available: true,
  recording: false,
  consentLine: LINE,
  startedAt: null,
  meetingId: null,
  ...over,
});
const ended = (notes: "processing" | "done", reason = "stopped" as const) => ({
  startedAt: "2026-10-26T12:00:00.000Z",
  durationMs: 1000,
  reason,
  notes,
});

function rig(options: { available?: boolean; micDenied?: boolean; failPush?: boolean } = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  let frames: ((f: Float32Array, r: number) => void) | undefined;
  const mic = { opened: 0, stopped: 0 };
  const source: AudioSource = {
    async start(cb) {
      if (options.micDenied) throw new Error("denied");
      mic.opened += 1;
      frames = cb;
      return () => {
        mic.stopped += 1;
      };
    },
  };
  let t = 0;
  const call = async (m: string, p: unknown) => {
    calls.push([m, p as Record<string, unknown>]);
    if (m === "meetings.record.status") return status({ available: options.available !== false });
    if (m === "meetings.record.start") {
      return status({ recording: true, startedAt: "2026-10-26T12:00:00.000Z", meetingId: "ev1" });
    }
    if (m === "meetings.record.push" && options.failPush) throw new Error("gone");
    if (m === "meetings.record.stop") return status({ last: ended("processing") });
    return {};
  };
  const client = new MeetingRecorderClient({ call, source, now: () => t });
  /** 48 kHz frames carrying `samples` 16 kHz samples. */
  const feed = (samples: number, level = 0.3) =>
    frames?.(new Float32Array(samples * 3).fill(level), 48_000);
  return { client, calls, mic, feed, at: (ms: number) => (t = ms) };
}
const names = (r: ReturnType<typeof rig>) => r.calls.map(([m]) => m);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("Record meeting on the device (§4.6)", () => {
  it("shows the consent line and does nothing else until it is confirmed", async () => {
    const r = rig();
    await r.client.request("ev1");
    expect(r.client.view.recording).toEqual({
      phase: "consent",
      consentLine: LINE,
      meetingId: "ev1",
    });
    expect(r.mic.opened).toBe(0);
    expect(names(r)).toEqual(["meetings.record.status"]);
    r.client.cancel();
    expect(r.client.view.recording.phase).toBe("idle");
    expect(names(r)).toEqual(["meetings.record.status"]);
  });

  it("is refused with a clear reason when nothing can turn audio into notes", async () => {
    const r = rig({ available: false });
    await r.client.request();
    expect(r.client.view).toMatchObject({ recording: { phase: "idle" }, error: "unavailable" });
  });

  it("confirm opens the microphone, streams ordered chunks and stop sends the rest", async () => {
    const r = rig();
    await r.client.request("ev1");
    await r.client.confirm();
    expect(r.calls.find(([m]) => m === "meetings.record.start")?.[1]).toEqual({
      consentConfirmed: true,
      meetingId: "ev1",
    });
    expect(r.client.view.recording).toMatchObject({ phase: "recording", meetingId: "ev1" });
    r.feed(CHUNK_SAMPLES);
    r.feed(CHUNK_SAMPLES);
    r.feed(8_000);
    await r.client.stop();
    const pushes = r.calls.filter(([m]) => m === "meetings.record.push").map(([, p]) => p.seq);
    expect(pushes).toEqual([0, 1, 2]);
    expect(r.calls.at(-1)).toEqual(["meetings.record.stop", { reason: "stopped" }]);
    expect(r.mic.stopped).toBe(1);
    expect(r.client.view).toMatchObject({
      recording: { phase: "idle" },
      notes: { notes: "processing" },
    });
  });

  it("a microphone that is denied never reaches the Gateway", async () => {
    const r = rig({ micDenied: true });
    await r.client.request();
    await r.client.confirm();
    expect(r.client.view).toMatchObject({ recording: { phase: "idle" }, error: "micDenied" });
    expect(names(r)).toEqual(["meetings.record.status"]);
  });

  it("a failed push ends the recording and releases the microphone", async () => {
    const r = rig({ failPush: true });
    await r.client.request();
    await r.client.confirm();
    r.feed(CHUNK_SAMPLES);
    await settle();
    expect(r.mic.stopped).toBe(1);
    expect(r.calls.at(-1)).toEqual(["meetings.record.stop", { reason: "source_ended" }]);
    expect(r.client.view.recording.phase).toBe("idle");
  });

  it("stops by itself after five minutes of silence", async () => {
    const r = rig();
    await r.client.request();
    await r.client.confirm();
    r.at(0);
    r.feed(1_600, 0);
    r.at(SILENCE_STOP_MS - 1000);
    r.feed(1_600, 0);
    expect(r.client.view.recording.phase).toBe("recording");
    r.at(SILENCE_STOP_MS + 1000);
    r.feed(1_600, 0);
    await settle();
    expect(r.calls.at(-1)).toEqual(["meetings.record.stop", { reason: "silence" }]);
    expect(r.mic.stopped).toBe(1);
  });

  it("an end announced by the Gateway (another device, the idle watchdog) releases the microphone", async () => {
    const r = rig();
    await r.client.request();
    await r.client.confirm();
    r.client.apply(status({ recording: false, last: ended("done", "source_ended" as never) }));
    expect(r.mic.stopped).toBe(1);
    expect(r.client.view).toMatchObject({ recording: { phase: "idle" }, notes: { notes: "done" } });
  });
});
