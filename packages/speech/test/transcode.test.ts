import type { AudioFormat, ChannelType } from "@psyche/protocol";
import { FakeSpeechEngine } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { float32ToS16le, PCM_16K_MONO, PCM_24K_MONO, pcmToFloat32, rms } from "../src/audio.ts";
import type { ProcessRunner } from "../src/process.ts";
import { oggOpusToCaf, opusPacketSamples, parseOggOpus } from "../src/transcode/caf.ts";
import { transcribeVoiceNote, VoiceNoteTranscoder } from "../src/transcode/ffmpeg.ts";
import { inboundFormat, VOICE_NOTE_PROFILES } from "../src/transcode/formats.ts";
import { ffmpegAvailable } from "./helpers.ts";

function sine(ms: number, format: AudioFormat, hz = 440): Uint8Array {
  const n = Math.round((ms * format.sampleRate) / 1000);
  const s = new Float32Array(n * format.channels);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < format.channels; c++) {
      s[i * format.channels + c] = 0.3 * Math.sin((2 * Math.PI * hz * i) / format.sampleRate);
    }
  }
  if (format.encoding === "pcm_f32le") return new Uint8Array(s.buffer);
  return float32ToS16le(s);
}

describe("voice-note formats per channel (N11)", () => {
  it("maps channels to containers and caps", () => {
    const pick = (c: ChannelType) => [
      VOICE_NOTE_PROFILES[c].container,
      VOICE_NOTE_PROFILES[c].maxBytes,
    ];
    expect(pick("telegram")).toEqual(["ogg_opus", 50 * 1024 * 1024]);
    expect(pick("whatsapp")).toEqual(["ogg_opus", 16 * 1024 * 1024]);
    expect(pick("imessage")[0]).toBe("caf_opus");
    expect(VOICE_NOTE_PROFILES.imessage.fileName).toBe("Audio Message.caf");
    for (const c of ["slack", "discord", "email"] as const) expect(pick(c)[0]).toBe("mp3");
    for (const p of Object.values(VOICE_NOTE_PROFILES)) {
      expect(p.channels).toBe(1);
      expect([...p.bitratesKbps].sort((a, b) => b - a)).toEqual([...p.bitratesKbps]);
    }
  });

  it("guesses inbound formats", () => {
    expect(inboundFormat("audio/ogg; codecs=opus")).toBe("opus");
    expect(inboundFormat("Audio Message.caf")).toBe("caf");
    expect(inboundFormat("audio/mpeg")).toBe("mp3");
    expect(inboundFormat("audio/amr")).toBe("unknown");
  });
});

describe("encoder bitrate ladder (no ffmpeg needed)", () => {
  it("walks down the ladder until the file fits, then refuses", async () => {
    const argvs: string[][] = [];
    // Fake ffmpeg: output size proportional to the requested bitrate.
    const runner: ProcessRunner = {
      async run(req) {
        argvs.push(req.argv);
        const kbps = Number(req.argv[req.argv.indexOf("-b:a") + 1]?.replace("k", ""));
        return { exitCode: 0, stdout: new Uint8Array(kbps * 100), stderr: "", timedOut: false };
      },
    };
    const t = new VoiceNoteTranscoder({ runner });
    const profile = { ...VOICE_NOTE_PROFILES.slack, maxBytes: 4_000 };
    const pcm = sine(100, PCM_24K_MONO);
    const out = await t.encode(pcm, PCM_24K_MONO, profile);
    expect(out.bitrateKbps).toBe(32);
    expect(argvs.map((a) => a[a.indexOf("-b:a") + 1])).toEqual(["64k", "48k", "32k"]);
    expect(argvs[0]).toEqual(
      expect.arrayContaining(["-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0"]),
    );
    await expect(t.encode(pcm, PCM_24K_MONO, { ...profile, maxBytes: 100 })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("refuses non-PCM input", async () => {
    const t = new VoiceNoteTranscoder({
      runner: {
        run: async () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: "", timedOut: false }),
      },
    });
    await expect(
      t.encode(new Uint8Array(4), { encoding: "mp3", sampleRate: 44_100, channels: 1 }, "telegram"),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("counts Opus packet samples from the TOC byte", () => {
    expect(opusPacketSamples(Uint8Array.of((31 << 3) | 0))).toBe(960); // CELT 20 ms
    expect(opusPacketSamples(Uint8Array.of((1 << 3) | 1))).toBe(1920); // SILK 20 ms × 2
    expect(opusPacketSamples(Uint8Array.of((16 << 3) | 3, 3))).toBe(360); // CELT 2.5 ms × 3
    expect(() => parseOggOpus(new TextEncoder().encode("not ogg at all, clearly not"))).toThrow();
  });
});

// Gate: ffmpeg and ffprobe with libopus + libmp3lame on PATH.
const ffmpeg = await ffmpegAvailable();
describe.skipIf(!ffmpeg)("transcoding matrix verified with ffprobe (live ffmpeg)", () => {
  const t = new VoiceNoteTranscoder();
  const inputs: AudioFormat[] = [
    PCM_24K_MONO,
    PCM_16K_MONO,
    { encoding: "pcm_s16le", sampleRate: 48_000, channels: 2 },
    { encoding: "pcm_f32le", sampleRate: 44_100, channels: 1 },
  ];
  const expected: Record<string, { formatName: string; codec: string; sampleRate: number }> = {
    ogg_opus: { formatName: "ogg", codec: "opus", sampleRate: 48_000 },
    caf_opus: { formatName: "caf", codec: "opus", sampleRate: 48_000 },
    mp3: { formatName: "mp3", codec: "mp3", sampleRate: 44_100 },
  };
  const channels: ChannelType[] = ["telegram", "whatsapp", "imessage", "slack", "discord", "email"];

  for (const input of inputs) {
    for (const channel of channels) {
      it(`${input.encoding} ${input.sampleRate} Hz ×${input.channels} → ${channel}`, async () => {
        const pcm = sine(1500, input);
        const note = await t.encode(pcm, input, channel);
        const profile = VOICE_NOTE_PROFILES[channel];
        expect(note.mime).toBe(profile.mime);
        expect(note.data.byteLength).toBeLessThanOrEqual(profile.maxBytes);
        const probe = await t.probe(note.data);
        expect(probe).toMatchObject({ ...expected[profile.container], channels: 1 });
        expect(Math.abs(probe.durationMs - 1500)).toBeLessThan(120);
        // Round trip: decodes back to ~1.5 s of 16 kHz mono with signal in it.
        const back = await t.decode(note.data);
        expect(Math.abs(back.byteLength / 32 - 1500)).toBeLessThan(120);
        expect(rms(pcmToFloat32(back, PCM_16K_MONO))).toBeGreaterThan(0.05);
      });
    }
  }

  it("remuxes Ogg/Opus into CAF without re-encoding", async () => {
    const ogg = await t.encode(sine(2000, PCM_24K_MONO), PCM_24K_MONO, "telegram");
    const stream = parseOggOpus(ogg.data);
    const caf = oggOpusToCaf(ogg.data);
    expect(new TextDecoder().decode(caf.subarray(0, 4))).toBe("caff");
    const audioBytes = stream.packets.reduce((n, p) => n + p.byteLength, 0);
    expect(caf.byteLength).toBeLessThan(audioBytes + 400);
    const probe = await t.probe(caf);
    expect(probe).toMatchObject({ formatName: "caf", codec: "opus", channels: 1 });
    expect(Math.abs(probe.durationMs - 2000)).toBeLessThan(30);
  });

  it("transcribes an inbound voice note through the decoder", async () => {
    const ogg = await t.encode(sine(1000, PCM_24K_MONO), PCM_24K_MONO, "whatsapp");
    const engine = new FakeSpeechEngine().transcript("on my way");
    const transcript = await transcribeVoiceNote(engine, t, ogg.data);
    expect(transcript.text).toBe("on my way");
  });

  it("rejects garbage input", async () => {
    await expect(t.decode(new TextEncoder().encode("definitely not audio"))).rejects.toThrow();
  });
});
