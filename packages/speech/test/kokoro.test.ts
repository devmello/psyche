import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PCM_16K_MONO, PCM_24K_MONO } from "../src/audio.ts";
import {
  chunkTokens,
  ipaToMisaki,
  KOKORO_MAX_TOKENS,
  KokoroEngine,
  KokoroOnnxRuntime,
  type KokoroRuntime,
  type OrtModuleLike,
  type Phonemizer,
  tokenizePhonemes,
} from "../src/engines/kokoro.ts";
import { PhonemizePhonemizer } from "../src/engines/phonemize.ts";
import { collect, FIXTURES } from "./helpers.ts";

const TOKENIZER = join(FIXTURES, "kokoro-tokenizer.json");
const vocab = new Map(
  Object.entries(
    (JSON.parse(readFileSync(TOKENIZER, "utf8")) as { model: { vocab: Record<string, number> } })
      .model.vocab,
  ),
);

describe("Kokoro G2P and tokens", () => {
  it("maps IPA onto misaki symbols", () => {
    expect(ipaToMisaki("həˈɫoʊ", "en-us")).toBe("həˈlO");
    expect(ipaToMisaki("naɪn ˈdɑɫɝ", "en-us")).toBe("nIn ˈdɑlɜɹ");
    expect(ipaToMisaki("ˈmɛsədʒ tʃeɪn bɔɪ aʊt", "en-us")).toBe("ˈmɛsəʤ ʧAn bY Wt");
    expect(ipaToMisaki("ɡəʊ", "en-gb")).toBe("ɡQ");
    expect(ipaToMisaki("ɑː", "en-us")).toBe("ɑ");
  });

  it("matches the recorded token plan for a sentence (real phonemize + tokenizer fixture)", async () => {
    const ipa = await new PhonemizePhonemizer().phonemize(
      "Hello Psyche, read this aloud.",
      "en-us",
    );
    const ids = tokenizePhonemes(ipaToMisaki(ipa, "en-us"), vocab);
    // Recorded 2026-10-19 with phonemize 2.0.1 and Kokoro-82M-v1.0-ONNX@1939ad2 tokenizer.json;
    // this plan synthesized intelligible audio (whisper.cpp tiny.en round trip).
    expect(ids).toEqual([
      50, 83, 156, 54, 31, 16, 156, 61, 25, 53, 51, 3, 16, 123, 51, 46, 16, 81, 102, 61, 16, 83,
      156, 54, 39, 46, 4,
    ]);
  });

  it("chunks long token runs at spaces under the model limit", () => {
    const space = vocab.get(" ") ?? 16;
    const ids = Array.from({ length: 1200 }, (_, i) => (i % 7 === 6 ? space : 50));
    const runs = chunkTokens(ids, space);
    expect(runs.every((r) => r.length <= KOKORO_MAX_TOKENS)).toBe(true);
    expect(runs.flat()).toEqual(ids);
    expect(runs[0]?.at(-1)).toBe(space);
  });
});

/** Fake ORT: records feeds, returns 10 ms of samples per input token. */
function fakeOrt() {
  const feeds: Record<
    string,
    { type: string; data: BigInt64Array | Float32Array; dims: number[] }
  >[] = [];
  const ort: OrtModuleLike = {
    InferenceSession: {
      create: async () => ({
        run: async (f: Record<string, unknown>) => {
          const typed = f as (typeof feeds)[number];
          feeds.push(typed);
          const n = (typed.input_ids?.dims[1] ?? 2) - 2;
          return { waveform: { data: new Float32Array(n * 240).fill(0.25) } };
        },
      }),
    },
    Tensor: class {
      readonly type: string;
      readonly data: BigInt64Array | Float32Array;
      readonly dims: number[];
      constructor(type: string, data: BigInt64Array | Float32Array, dims: number[]) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    } as unknown as OrtModuleLike["Tensor"],
  };
  return { ort, feeds };
}

function voicesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "psyche-kokoro-"));
  const style = new Float32Array(510 * 256);
  for (let r = 0; r < 510; r++) style.fill(r, r * 256, (r + 1) * 256);
  writeFileSync(join(dir, "af_heart.bin"), new Uint8Array(style.buffer));
  writeFileSync(join(dir, "bf_emma.bin"), new Uint8Array(12));
  writeFileSync(join(dir, "model.onnx"), new Uint8Array(1));
  return dir;
}

describe("KokoroOnnxRuntime model contract", () => {
  it("pads input_ids, picks the style row by length and passes speed", async () => {
    const dir = voicesDir();
    const { ort, feeds } = fakeOrt();
    const rt = new KokoroOnnxRuntime({
      ort,
      modelPath: join(dir, "model.onnx"),
      tokenizerPath: TOKENIZER,
      voicesDir: dir,
    });
    expect(await rt.available()).toBe(true);
    const wave = await rt.infer([50, 83, 156], "af_heart", 1.2);
    expect(wave.length).toBe(3 * 240);
    const f = feeds[0];
    expect([...(f?.input_ids?.data ?? [])]).toEqual([0n, 50n, 83n, 156n, 0n]);
    expect(f?.input_ids?.dims).toEqual([1, 5]);
    expect(f?.style?.dims).toEqual([1, 256]);
    expect(f?.style?.data[0]).toBe(3); // row = token count
    expect([...(f?.speed?.data ?? [])]).toEqual([expect.closeTo(1.2, 5)]);
    await expect(rt.infer(new Array(511).fill(1), "af_heart", 1)).rejects.toMatchObject({
      code: "invalid_params",
    });
    // Path traversal and malformed voice files are refused.
    expect(await rt.hasVoice("../../etc/passwd")).toBe(false);
    await expect(rt.infer([1], "bf_emma", 1)).rejects.toThrow(/wrong size/);
  });
});

describe("KokoroEngine synthesis", () => {
  const phonemizer: Phonemizer = {
    name: "letters",
    // One "phoneme" per letter: deterministic token counts.
    phonemize: async (text) => text.toLowerCase().replace(/[^a-z ]/g, ""),
  };
  const runtime: KokoroRuntime & { calls: [number, string, number][] } = {
    calls: [],
    available: async () => true,
    vocab: async () => vocab,
    hasVoice: async (v) => v === "af_heart" || v === "bm_george",
    async infer(ids, voice, speed) {
      this.calls.push([ids.length, voice, speed]);
      return new Float32Array(ids.length * 240).fill(0.5);
    },
  };

  it("synthesizes sentences, SSML pauses and rates into 24 kHz PCM", async () => {
    runtime.calls.length = 0;
    const engine = new KokoroEngine({ runtime, phonemizer });
    const out = await collect(
      engine.synthesize('Hi there. <break time="200ms"/><prosody rate="slow">Bye now</prosody>'),
    );
    expect(out.map((c) => c.format)).toEqual([PCM_24K_MONO, PCM_24K_MONO, PCM_24K_MONO]);
    // "hi there" = 8 tokens → 1920 samples → 3840 bytes; 200 ms of silence = 4800 samples.
    expect(out.map((c) => c.data.byteLength)).toEqual([3840, 9600, 3360]);
    expect(runtime.calls).toEqual([
      [8, "af_heart", 1],
      [7, "af_heart", 0.8],
    ]);
  });

  it("resamples to a requested PCM format and refuses compressed output", async () => {
    const engine = new KokoroEngine({ runtime, phonemizer });
    const out = await collect(
      engine.synthesize("hello", { format: PCM_16K_MONO, voice: "bm_george" }),
    );
    expect(out[0]?.data.byteLength).toBe(Math.round((5 * 240 * 16) / 24) * 2);
    await expect(
      collect(
        engine.synthesize("x", { format: { encoding: "mp3", sampleRate: 44_100, channels: 1 } }),
      ),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(collect(engine.synthesize("x", { voice: "zz_none" }))).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("lists only installed voices and reports capabilities", async () => {
    const engine = new KokoroEngine({ runtime, phonemizer });
    expect((await engine.voices()).map((v) => [v.id, v.language])).toEqual([
      ["af_heart", "en-us"],
      ["bm_george", "en-gb"],
    ]);
    expect(await engine.capabilities()).toMatchObject({ synthesis: true, streaming: false });
    expect(await engine.available()).toBe(true);
    await expect(engine.transcribeFile()).rejects.toMatchObject({ code: "not_implemented" });
  });
});
