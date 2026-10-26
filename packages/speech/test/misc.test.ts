import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeWav,
  encodeWav,
  PCM_16K_MONO,
  PCM_24K_MONO,
  pcmDurationMs,
  toPcm16kMono,
} from "../src/audio.ts";
import { MODEL_CATALOG } from "../src/catalog.ts";
import {
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
  webSpeechDictation,
} from "../src/engines/web.ts";
import { ModelManager } from "../src/models.ts";
import { LocalProcessRunner } from "../src/process.ts";
import { collect } from "./helpers.ts";

describe("PCM helpers", () => {
  it("round-trips WAV and converts to 16 kHz mono", () => {
    const pcm = new Uint8Array(48_000); // 1 s of 24 kHz s16 mono
    const wav = decodeWav(encodeWav(pcm, PCM_24K_MONO));
    expect(wav?.format).toEqual(PCM_24K_MONO);
    expect(wav?.data.byteLength).toBe(48_000);
    expect(pcmDurationMs(toPcm16kMono(pcm, PCM_24K_MONO).byteLength, PCM_16K_MONO)).toBe(1000);
    expect(decodeWav(new TextEncoder().encode("RIFF....WAVEjunk"))).toBeUndefined();
  });
});

describe("model download manager", () => {
  const bytes = new TextEncoder().encode("pretend this is a ggml model");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const spec = {
    id: "whisper-test",
    engine: "whisper",
    file: "whisper/ggml-test.bin",
    url: "https://example.invalid/ggml-test.bin",
    sha256: sha,
    sizeBytes: bytes.byteLength,
    license: "MIT",
  };

  it("downloads, verifies and renames into $PSYCHE_HOME/models with private modes", async () => {
    const home = mkdtempSync(join(tmpdir(), "psyche-home-"));
    let fetches = 0;
    const mm = new ModelManager({
      home,
      catalog: [spec],
      fetch: async () => {
        fetches++;
        return new Response(bytes);
      },
    });
    expect(await mm.has("whisper-test")).toBe(false);
    const progress: number[] = [];
    const [a, b] = await Promise.all([
      mm.ensure("whisper-test", { onProgress: (p) => progress.push(p.receivedBytes) }),
      mm.ensure("whisper-test"),
    ]);
    expect(a).toBe(join(home, "models", "whisper", "ggml-test.bin"));
    expect(b).toBe(a);
    expect(fetches).toBe(1);
    expect(progress.at(-1)).toBe(bytes.byteLength);
    expect(readFileSync(a)).toEqual(Buffer.from(bytes));
    expect(statSync(a).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "models")).mode & 0o777).toBe(0o700);
    expect(await mm.verify("whisper-test")).toBe(true);
    await mm.ensure("whisper-test");
    expect(fetches).toBe(1);
  });

  it("rejects a checksum mismatch and leaves nothing behind", async () => {
    const home = mkdtempSync(join(tmpdir(), "psyche-home-"));
    const mm = new ModelManager({
      home,
      catalog: [spec],
      fetch: async () => new Response(new TextEncoder().encode("tampered bytes of same len!!")),
    });
    await expect(mm.ensure("whisper-test")).rejects.toThrow(/checksum mismatch/);
    expect(await mm.has("whisper-test")).toBe(false);
    expect(() => statSync(`${mm.path("whisper-test")}.part`)).toThrow();
  });

  it("refuses plain HTTP, bad hashes, path escapes and HTTP errors", async () => {
    expect(() => new ModelManager({ catalog: [{ ...spec, url: "http://x/y" }] })).toThrow(/https/);
    expect(() => new ModelManager({ catalog: [{ ...spec, sha256: "abc" }] })).toThrow(/sha256/);
    const mm = new ModelManager({
      home: mkdtempSync(join(tmpdir(), "psyche-home-")),
      catalog: [{ ...spec, file: "../../escape.bin" }],
      fetch: async () => new Response("x", { status: 503 }),
    });
    expect(() => mm.path("whisper-test")).toThrow(/escapes/);
    const mm2 = new ModelManager({
      home: mkdtempSync(join(tmpdir(), "psyche-home-")),
      catalog: [spec],
      fetch: async () => new Response("x", { status: 503 }),
    });
    await expect(mm2.ensure("whisper-test")).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
  });

  it("ships a well-formed catalog", () => {
    const ids = new Set<string>();
    for (const s of MODEL_CATALOG) {
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
      expect(s.url.startsWith("https://huggingface.co/")).toBe(true);
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.sizeBytes).toBeGreaterThan(0);
    }
    expect(ids.has("whisper-base.en")).toBe(true);
    // Psyche does not speak: no synthesis models are shipped.
    expect([...ids].some((id) => id.startsWith("kokoro"))).toBe(false);
    expect(() => new ModelManager({ catalog: MODEL_CATALOG })).not.toThrow();
  });
});

describe("process runner", () => {
  it("runs argv without a shell, reports a missing binary as unavailable", async () => {
    const r = new LocalProcessRunner();
    const out = await r.run({ argv: ["node", "-e", "process.stdout.write('a; echo b')"] });
    expect(new TextDecoder().decode(out.stdout)).toBe("a; echo b");
    await expect(r.run({ argv: ["psyche-no-such-binary"] })).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(r.run({ argv: [] })).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("does not pass the parent environment through", async () => {
    process.env.PSYCHE_TEST_LEAK = "leaky";
    try {
      const out = await new LocalProcessRunner().run({
        argv: ["node", "-e", "process.stdout.write(String(process.env.PSYCHE_TEST_LEAK))"],
      });
      expect(new TextDecoder().decode(out.stdout)).toBe("undefined");
    } finally {
      delete process.env.PSYCHE_TEST_LEAK;
    }
  });

  it("kills on timeout", async () => {
    const out = await new LocalProcessRunner().run({
      argv: ["node", "-e", "setTimeout(() => {}, 10000)"],
      timeoutMs: 200,
    });
    expect(out.timedOut).toBe(true);
  });
});

describe("Web Speech client helper", () => {
  class FakeRecognition implements SpeechRecognitionLike {
    static last: FakeRecognition | undefined;
    lang = "";
    continuous = false;
    interimResults = false;
    onresult: SpeechRecognitionLike["onresult"] = null;
    onerror: SpeechRecognitionLike["onerror"] = null;
    onend: SpeechRecognitionLike["onend"] = null;
    started = false;
    constructor() {
      FakeRecognition.last = this;
    }
    start() {
      this.started = true;
    }
    stop() {
      this.onend?.();
    }
    abort() {
      this.onend?.();
    }
    emit(results: [string, boolean][], resultIndex = 0) {
      const list = results.map(([t, isFinal]) =>
        Object.assign([{ transcript: t, confidence: 0.9 }], { isFinal }),
      );
      this.onresult?.({ resultIndex, results: list } as unknown as SpeechRecognitionEventLike);
    }
  }

  it("turns interim results into partials and final results into finals", async () => {
    let now = 0;
    const d = webSpeechDictation(FakeRecognition, { language: "en-GB", now: () => now });
    const rec = FakeRecognition.last as FakeRecognition;
    expect([rec.lang, rec.continuous, rec.interimResults, rec.started]).toEqual([
      "en-GB",
      true,
      true,
      true,
    ]);
    now = 400;
    rec.emit([["call", false]]);
    now = 900;
    rec.emit([["call alice", true]]);
    now = 1200;
    rec.emit(
      [
        ["call alice", true],
        ["at", false],
      ],
      1,
    );
    d.stop();
    const segs = await collect(d.segments);
    expect(segs.map((s) => [s.text, s.final, s.startMs, s.endMs])).toEqual([
      ["call", false, 0, 400],
      ["call alice", true, 0, 900],
      ["at", false, 900, 1200],
      ["at", true, 900, 1200],
    ]);
  });

  it("drops pending speech on abort and surfaces real errors", async () => {
    const d = webSpeechDictation(FakeRecognition);
    (FakeRecognition.last as FakeRecognition).emit([["hmm", false]]);
    d.abort();
    expect((await collect(d.segments)).map((s) => s.final)).toEqual([false]);
    const e = webSpeechDictation(FakeRecognition);
    (FakeRecognition.last as FakeRecognition).onerror?.({ error: "not-allowed" });
    await expect(collect(e.segments)).rejects.toThrow(/not-allowed/);
  });
});
