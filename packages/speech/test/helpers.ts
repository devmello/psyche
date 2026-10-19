import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { decodeWav, float32ToS16le } from "../src/audio.ts";
import { psycheHome } from "../src/models.ts";
import { findBinary, LocalProcessRunner } from "../src/process.ts";

export const FIXTURES = join(import.meta.dirname, "fixtures");

/** 4.5 s, 16 kHz mono, Kokoro af_heart: "Hello Psyche. Remind me to call Alice at noon tomorrow." */
export function remindAliceClip() {
  const wav = decodeWav(readFileSync(join(FIXTURES, "remind-alice.wav")));
  if (wav === undefined) throw new Error("fixture is not a PCM WAV");
  return wav;
}

export async function* chunks(data: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let off = 0; off < data.byteLength; off += size) yield data.subarray(off, off + size);
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** 16 kHz mono s16le: `pattern` of [ms, amplitude] runs (amplitude 0 = silence, else 300 Hz tone). */
export function tonePcm(pattern: [number, number][], rate = 16_000): Uint8Array {
  const total = pattern.reduce((n, [ms]) => n + Math.round((ms * rate) / 1000), 0);
  const s = new Float32Array(total);
  let i = 0;
  for (const [ms, amp] of pattern) {
    const n = Math.round((ms * rate) / 1000);
    for (let k = 0; k < n; k++, i++) s[i] = amp * Math.sin((2 * Math.PI * 300 * i) / rate);
  }
  return float32ToS16le(s);
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** ffmpeg + ffprobe with libopus and libmp3lame, or `undefined` (tests skip). */
export async function ffmpegAvailable(): Promise<boolean> {
  if ((await findBinary("ffmpeg")) === undefined || (await findBinary("ffprobe")) === undefined) {
    return false;
  }
  const r = await new LocalProcessRunner()
    .run({ argv: ["ffmpeg", "-hide_banner", "-encoders"], timeoutMs: 10_000 })
    .catch(() => undefined);
  const out = r === undefined ? "" : new TextDecoder().decode(r.stdout);
  return out.includes("libopus") && out.includes("libmp3lame");
}

/**
 * whisper.cpp gate: `PSYCHE_WHISPER_CLI` (default `whisper-cli` on PATH) and a model at
 * `PSYCHE_WHISPER_MODEL` (default `$PSYCHE_HOME/models/whisper/ggml-tiny.en.bin`).
 */
export async function whisperGate(): Promise<{ binary: string; model: string } | undefined> {
  const binary = await findBinary(process.env.PSYCHE_WHISPER_CLI ?? "whisper-cli");
  const model =
    process.env.PSYCHE_WHISPER_MODEL ?? join(psycheHome(), "models", "whisper", "ggml-tiny.en.bin");
  if (binary === undefined || !(await exists(model))) return undefined;
  return { binary, model };
}
