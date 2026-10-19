import { describe, expect, it } from "vitest";
import { PCM_16K_MONO, pcmBytesFor } from "../src/audio.ts";
import {
  cleanWhisperText,
  isEnglishOnlyModel,
  parseWhisperCliJson,
  type WhisperBackend,
  WhisperCliBackend,
  WhisperEngine,
  type WhisperRequest,
  WhisperServerBackend,
} from "../src/engines/whisper.ts";
import type { ProcessRequest, ProcessRunner } from "../src/process.ts";
import { chunks, collect, remindAliceClip, tonePcm, whisperGate } from "./helpers.ts";

/** Backend that "hears" one word per 300 ms of audio and records every request. */
class CountingBackend implements WhisperBackend {
  readonly name = "counting";
  readonly requests: WhisperRequest[] = [];
  readonly words = ["call", "alice", "at", "noon", "tomorrow", "please"];
  async available() {
    return true;
  }
  async transcribe(req: WhisperRequest) {
    this.requests.push(req);
    const ms = (req.pcm.byteLength / 32_000) * 1000;
    const n = Math.max(1, Math.min(this.words.length, Math.floor(ms / 300)));
    return [{ text: this.words.slice(0, n).join(" "), startMs: 0, endMs: ms }];
  }
}

describe("whisper.cpp streaming (VAD-gated chunked inference)", () => {
  it("emits growing partials, then a final per utterance, in order", async () => {
    const backend = new CountingBackend();
    const engine = new WhisperEngine({ backend, englishOnly: true });
    // 300 ms silence, 2.2 s speech, 900 ms silence, 1 s speech, 200 ms silence (end of input).
    const pcm = tonePcm([
      [300, 0],
      [2200, 0.3],
      [900, 0],
      [1000, 0.3],
      [200, 0],
    ]);
    const segs = await collect(
      engine.transcribeStream(chunks(pcm, pcmBytesFor(100, PCM_16K_MONO)), PCM_16K_MONO, {
        vocabulary: ["Alice"],
      }),
    );
    const finals = segs.filter((s) => s.final);
    expect(finals).toHaveLength(2);
    // Partials come before their final and never after the last final.
    const firstFinal = segs.indexOf(finals[0] as (typeof segs)[number]);
    expect(segs.slice(0, firstFinal).every((s) => !s.final)).toBe(true);
    expect(firstFinal).toBeGreaterThanOrEqual(2);
    expect(segs.at(-1)?.final).toBe(true);
    // Finals do not overlap and the first one starts near the speech onset (with pre-roll).
    expect(finals[0]?.startMs).toBeGreaterThanOrEqual(60);
    expect(finals[0]?.startMs).toBeLessThanOrEqual(300);
    expect(finals[1]?.startMs).toBeGreaterThanOrEqual(finals[0]?.endMs ?? 0);
    // Vocabulary goes into every prompt; after the first final, so does its text.
    expect(backend.requests.every((r) => r.prompt?.includes("Alice"))).toBe(true);
    const afterFirst = backend.requests.at(-1);
    expect(afterFirst?.prompt).toContain(finals[0]?.text);
    expect(backend.requests.every((r) => r.language === "en")).toBe(true);
  });

  it("finalizes an utterance at the maximum length even without a pause", async () => {
    const engine = new WhisperEngine({
      backend: new CountingBackend(),
      stream: { maxUtteranceMs: 1_000, partialIntervalMs: 0 },
    });
    const segs = await collect(
      engine.transcribeStream(chunks(tonePcm([[2500, 0.3]]), 3200), PCM_16K_MONO),
    );
    expect(segs.map((s) => s.final)).toEqual([true, true, true]);
  });

  it("transcribes nothing from silence", async () => {
    const backend = new CountingBackend();
    const engine = new WhisperEngine({ backend });
    expect(
      await collect(engine.transcribeStream(chunks(tonePcm([[2000, 0]]), 3200), PCM_16K_MONO)),
    ).toEqual([]);
    expect(backend.requests).toHaveLength(0);
  });

  it("accepts 48 kHz stereo input chunks split mid-frame", async () => {
    const backend = new CountingBackend();
    const engine = new WhisperEngine({ backend });
    const fmt = { encoding: "pcm_s16le" as const, sampleRate: 48_000, channels: 2 };
    const mono16 = tonePcm([[1500, 0.3]], 48_000);
    const stereo = new Uint8Array(mono16.byteLength * 2);
    for (let i = 0; i < mono16.byteLength; i += 2) {
      stereo.set(mono16.subarray(i, i + 2), i * 2);
      stereo.set(mono16.subarray(i, i + 2), i * 2 + 2);
    }
    const segs = await collect(engine.transcribeStream(chunks(stereo, 1001), fmt));
    expect(segs.at(-1)?.final).toBe(true);
    // 1.5 s of speech → ~1.5 s of 16 kHz mono in the last request.
    const last = backend.requests.at(-1);
    expect(Math.abs((last?.pcm.byteLength ?? 0) - 48_000)).toBeLessThan(8_000);
  });

  it("splits files at pauses so whisper does not drop speech after a gap", async () => {
    const backend = new CountingBackend();
    const engine = new WhisperEngine({ backend });
    const t = await engine.transcribeFile(
      tonePcm([
        [1000, 0.3],
        [1200, 0],
        [900, 0.3],
      ]),
      PCM_16K_MONO,
    );
    expect(t.segments).toHaveLength(2);
    expect(backend.requests).toHaveLength(2);
  });

  it("rejects non-PCM streams and needs a decoder for compressed files", async () => {
    const engine = new WhisperEngine({ backend: new CountingBackend() });
    expect(() =>
      engine.transcribeStream(chunks(new Uint8Array(4), 2), {
        encoding: "opus",
        sampleRate: 48_000,
        channels: 1,
      }),
    ).toThrow(/raw PCM/);
    await expect(
      engine.transcribeFile(new Uint8Array(4), {
        encoding: "mp3",
        sampleRate: 44_100,
        channels: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("whisper-cli backend", () => {
  it("builds an argv with the vocabulary prompt and never a shell string", async () => {
    const runs: ProcessRequest[] = [];
    const runner: ProcessRunner = {
      async run(req) {
        runs.push(req);
        const json = JSON.stringify({
          transcription: [
            { offsets: { from: 0, to: 900 }, text: " Call Alice." },
            { offsets: { from: 900, to: 1200 }, text: " [BLANK_AUDIO]" },
          ],
        });
        return {
          exitCode: 0,
          stdout: new TextEncoder().encode(`whisper_init...\n${json}`),
          stderr: "",
          timedOut: false,
        };
      },
    };
    const backend = new WhisperCliBackend({
      modelPath: "/models/ggml-base.en.bin",
      runner,
      threads: 2,
      vadModelPath: "/models/vad.bin",
    });
    const segs = await backend.transcribe({
      pcm: new Uint8Array(3200),
      language: "en",
      prompt: "Pip, Alice.",
      vad: true,
    });
    expect(segs).toEqual([{ text: "Call Alice.", startMs: 0, endMs: 900 }]);
    const argv = runs[0]?.argv ?? [];
    expect(argv[0]).toBe("whisper-cli");
    expect(argv).toEqual(
      expect.arrayContaining(["-m", "/models/ggml-base.en.bin", "-oj", "-of", "-"]),
    );
    expect(argv[argv.indexOf("--prompt") + 1]).toBe("Pip, Alice.");
    expect(argv[argv.indexOf("-t") + 1]).toBe("2");
    expect(argv).toEqual(expect.arrayContaining(["--vad", "-vm", "/models/vad.bin"]));
  });

  it("surfaces a failing exit as an error", async () => {
    const runner: ProcessRunner = {
      run: async () => ({
        exitCode: 3,
        stdout: new Uint8Array(),
        stderr: "error: failed to open model",
        timedOut: false,
      }),
    };
    const backend = new WhisperCliBackend({ modelPath: "/m", runner });
    await expect(backend.transcribe({ pcm: new Uint8Array(32) })).rejects.toThrow(
      /failed to open model/,
    );
  });

  it("parses JSON and filters non-speech tags", () => {
    expect(() => parseWhisperCliJson("no json")).toThrow();
    expect(cleanWhisperText(" (music) ")).toBe("");
    expect(cleanWhisperText("*laughs*")).toBe("");
    expect(cleanWhisperText("  Hi  there ")).toBe("Hi there");
    expect(isEnglishOnlyModel("/x/ggml-base.en.bin")).toBe(true);
    expect(isEnglishOnlyModel("/x/ggml-large-v3-turbo.bin")).toBe(false);
  });
});

describe("whisper-server backend", () => {
  it("refuses a non-loopback server", () => {
    expect(() => new WhisperServerBackend({ baseUrl: "http://10.0.0.5:8080" })).toThrow(/loopback/);
  });

  it("posts multipart WAV and reads verbose_json", async () => {
    const calls: { url: string; body: FormData }[] = [];
    const backend = new WhisperServerBackend({
      baseUrl: "http://127.0.0.1:8178",
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: init?.body as FormData });
        return Response.json({ segments: [{ text: " Hi Pip.", start: 0.5, end: 1.25 }] });
      },
    });
    const segs = await backend.transcribe({ pcm: new Uint8Array(3200), prompt: "Pip." });
    expect(segs).toEqual([{ text: "Hi Pip.", startMs: 500, endMs: 1250 }]);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8178/inference");
    expect(calls[0]?.body.get("response_format")).toBe("verbose_json");
    expect(calls[0]?.body.get("prompt")).toBe("Pip.");
    const file = calls[0]?.body.get("file") as Blob;
    const head = new Uint8Array(await file.arrayBuffer()).subarray(0, 4);
    expect(new TextDecoder().decode(head)).toBe("RIFF");
  });
});

// Gate: whisper-cli on PATH (or PSYCHE_WHISPER_CLI) and a model (PSYCHE_WHISPER_MODEL, default
// $PSYCHE_HOME/models/whisper/ggml-tiny.en.bin). CI has neither, so this is skipped there.
const gate = await whisperGate();
describe.skipIf(gate === undefined)("whisper.cpp on the fixture clip (live binary)", () => {
  const engine = () =>
    new WhisperEngine({
      backend: new WhisperCliBackend({
        binary: gate?.binary ?? "",
        modelPath: gate?.model ?? "",
      }),
      englishOnly: true,
    });

  it("transcribes the fixture file", { timeout: 60_000 }, async () => {
    const clip = remindAliceClip();
    const t = await engine().transcribeFile(clip.data, clip.format, { vocabulary: ["Alice"] });
    expect(t.text.toLowerCase()).toMatch(/remind me to call alice at noon/);
    expect(t.language).toBe("en");
  });

  it("streams the fixture with partials before finals", { timeout: 120_000 }, async () => {
    const clip = remindAliceClip();
    const segs = await collect(
      engine().transcribeStream(chunks(clip.data, pcmBytesFor(200, clip.format)), clip.format),
    );
    const text = segs
      .filter((s) => s.final)
      .map((s) => s.text)
      .join(" ")
      .toLowerCase();
    expect(text).toMatch(/call alice/);
    expect(segs.some((s) => !s.final)).toBe(true);
    expect(segs.at(-1)?.final).toBe(true);
  });
});
