import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pcmBytesFor } from "../src/audio.ts";
import { type WhisperBackend, WhisperEngine } from "../src/engines/whisper.ts";
import {
  ManagedWhisperServerBackend,
  WhisperServerProcess,
} from "../src/engines/whisper-server-process.ts";
import { psycheHome } from "../src/models.ts";
import { WhisperRuntime, whisperRuntimeFor } from "../src/runtime.ts";
import { FIXTURES, remindAliceClip } from "./helpers.ts";

/**
 * The real pinned whisper.cpp runtime on Windows with base.en, on the fixture clip. Gate: win32,
 * the model at `PSYCHE_WHISPER_MODEL` (default `$PSYCHE_HOME/models/whisper/ggml-base.en.bin`)
 * and the release zip at `PSYCHE_WHISPER_RUNTIME_ZIP` (installed from it into a temp home, so
 * the pinned zip and member hashes and Windows' tar are all exercised without the network).
 * Prints cold start, file and streaming latencies.
 */
const spec = whisperRuntimeFor();
const model =
  process.env.PSYCHE_WHISPER_MODEL ?? join(psycheHome(), "models", "whisper", "ggml-base.en.bin");
const zip = process.env.PSYCHE_WHISPER_RUNTIME_ZIP;
const gate =
  process.platform === "win32" &&
  spec !== undefined &&
  existsSync(model) &&
  zip !== undefined &&
  existsSync(zip);

const home = mkdtempSync(join(tmpdir(), "psyche-wlive-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe.skipIf(!gate)("whisper.cpp on Windows (live, pinned runtime, base.en)", () => {
  let proc: WhisperServerProcess | undefined;
  const requests: { audioMs: number; ctx: number; ms: number; prompt: string; text: string }[] = [];
  afterAll(async () => {
    await proc?.stop();
  });

  const engine = async () => {
    if (spec === undefined || zip === undefined) throw new Error("gate");
    const runtime = new WhisperRuntime({
      home,
      spec,
      fetch: (async () => new Response(readFileSync(zip))) as unknown as typeof fetch,
    });
    await runtime.ensure();
    proc ??= new WhisperServerProcess({
      serverPath: runtime.serverPath,
      modelPath: model,
      workDir: join(home, "speech", "whisper-server"),
    });
    const managed = new ManagedWhisperServerBackend({ process: proc, ready: async () => true });
    const backend: WhisperBackend & { warm(): Promise<void> } = {
      name: managed.name,
      available: () => managed.available(),
      warm: () => managed.warm(),
      transcribe: async (req) => {
        const t0 = performance.now();
        const out = await managed.transcribe(req);
        requests.push({
          audioMs: Math.round(req.pcm.byteLength / 32),
          ctx: req.audioCtx ?? 1500,
          ms: Math.round(performance.now() - t0),
          prompt: req.prompt ?? "",
          text: out.map((s) => s.text).join(" "),
        });
        return out;
      },
    };
    return { engine: new WhisperEngine({ backend, englishOnly: true }), backend, runtime };
  };

  it("installs the pinned runtime and transcribes the fixture file", {
    timeout: 120_000,
  }, async () => {
    const { engine: e, backend, runtime } = await engine();
    expect(await runtime.verify()).toBe(true);
    let t0 = performance.now();
    await backend.warm();
    const coldMs = performance.now() - t0;
    const clip = remindAliceClip();
    requests.length = 0;
    t0 = performance.now();
    const first = await e.transcribeFile(clip.data, clip.format, {
      vocabulary: ["Psyche", "Alice"],
    });
    const fileMs = performance.now() - t0;
    t0 = performance.now();
    const plain = await e.transcribeFile(clip.data, clip.format);
    const warmMs = performance.now() - t0;
    t0 = performance.now();
    const onDisk = await e.transcribePath(join(FIXTURES, "remind-alice.wav"));
    const pathMs = performance.now() - t0;
    process.stdout.write(
      JSON.stringify(
        {
          coldStartMs: Math.round(coldMs),
          file: { ms: Math.round(fileMs), text: first.text },
          fileNoVocabulary: { ms: Math.round(warmMs), text: plain.text },
          path: { ms: Math.round(pathMs), text: onDisk.text, audioMs: onDisk.audioMs },
          model,
          requests,
        },
        null,
        2,
      ),
    );
    expect(first.text.toLowerCase()).toMatch(/me to call alice at noon tomorrow/);
    expect(onDisk.text.toLowerCase()).toMatch(/me to call alice at noon tomorrow/);
  });

  it("streams in real time with partials before the final", { timeout: 120_000 }, async () => {
    const { engine: e } = await engine();
    const clip = remindAliceClip();
    const step = pcmBytesFor(100, clip.format);
    let sent = 0;
    let lastChunkAt = 0;
    async function* live(): AsyncIterable<Uint8Array> {
      for (let off = 0; off < clip.data.byteLength; off += step) {
        yield clip.data.subarray(off, off + step);
        sent = Math.min(clip.data.byteLength, off + step);
        await new Promise((r) => setTimeout(r, 100));
      }
      lastChunkAt = performance.now();
    }
    requests.length = 0;
    const t0 = performance.now();
    const seen: { atMs: number; audioMs: number; final: boolean; text: string }[] = [];
    for await (const s of e.transcribeStream(live(), clip.format, { vocabulary: ["Psyche"] })) {
      seen.push({
        atMs: Math.round(performance.now() - t0),
        audioMs: Math.round(sent / pcmBytesFor(1, clip.format)),
        final: s.final,
        text: s.text,
      });
    }
    const endToFinal = Math.round(performance.now() - lastChunkAt);
    process.stdout.write(
      JSON.stringify({ segments: seen, lastAudioToFinalMs: endToFinal, requests }, null, 2),
    );
    expect(seen.some((s) => !s.final)).toBe(true);
    expect(seen.at(-1)?.final).toBe(true);
    const text = seen
      .filter((s) => s.final)
      .map((s) => s.text)
      .join(" ")
      .toLowerCase();
    expect(text).toMatch(/me to call alice at noon tomorrow/);
  });
});
