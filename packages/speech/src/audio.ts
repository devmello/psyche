import { type AudioFormat, PsycheError } from "@psyche/protocol";

/** whisper.cpp, Parakeet and SpeechAnalyzer all want 16 kHz mono for recognition. */
export const PCM_16K_MONO: AudioFormat = { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 };
/** Kokoro-82M and OpenAI `pcm` output. */
export const PCM_24K_MONO: AudioFormat = { encoding: "pcm_s16le", sampleRate: 24_000, channels: 1 };

export function isPcm(format: AudioFormat): boolean {
  return format.encoding === "pcm_s16le" || format.encoding === "pcm_f32le";
}

export function bytesPerSample(format: AudioFormat): number {
  if (format.encoding === "pcm_s16le") return 2;
  if (format.encoding === "pcm_f32le") return 4;
  throw new PsycheError("invalid_params", `${format.encoding} is not raw PCM`);
}

/** Duration of a raw PCM buffer in milliseconds. */
export function pcmDurationMs(byteLength: number, format: AudioFormat): number {
  const frame = bytesPerSample(format) * format.channels;
  return Math.round(((byteLength / frame) * 1000) / format.sampleRate);
}

/** Byte length of `ms` of raw PCM, rounded down to a whole frame. */
export function pcmBytesFor(ms: number, format: AudioFormat): number {
  const frame = bytesPerSample(format) * format.channels;
  return Math.floor((ms * format.sampleRate) / 1000) * frame;
}

/** Decodes raw PCM into mono float samples in [-1, 1] (channels are averaged). */
export function pcmToFloat32(data: Uint8Array, format: AudioFormat): Float32Array {
  const bps = bytesPerSample(format);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const frames = Math.floor(data.byteLength / (bps * format.channels));
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < format.channels; c++) {
      const off = (f * format.channels + c) * bps;
      sum += bps === 2 ? view.getInt16(off, true) / 32768 : view.getFloat32(off, true);
    }
    out[f] = sum / format.channels;
  }
  return out;
}

/** Encodes float samples as 16-bit little-endian PCM, clipping to [-1, 1]. */
export function float32ToS16le(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return out;
}

/** Linear-interpolation resampler; good enough for speech going into a recognizer. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const length = Math.max(0, Math.round((samples.length * to) / from));
  const out = new Float32Array(length);
  const ratio = from / to;
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const t = pos - i0;
    out[i] = (samples[i0] ?? 0) * (1 - t) + (samples[i1] ?? 0) * t;
  }
  return out;
}

/** Converts any raw PCM to 16 kHz mono s16le, the recognizer input format. */
export function toPcm16kMono(data: Uint8Array, format: AudioFormat): Uint8Array {
  if (
    format.encoding === "pcm_s16le" &&
    format.sampleRate === 16_000 &&
    format.channels === 1 &&
    data.byteLength % 2 === 0
  ) {
    return data;
  }
  return float32ToS16le(resample(pcmToFloat32(data, format), format.sampleRate, 16_000));
}

/** Root-mean-square level of a float buffer (0 = silence, ~0.7 = full-scale sine). */
export function rms(samples: Float32Array, start = 0, end = samples.length): number {
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / (end - start));
}

/** Wraps raw PCM in a canonical 44-byte RIFF/WAVE header. */
export function encodeWav(data: Uint8Array, format: AudioFormat): Uint8Array {
  const bps = bytesPerSample(format);
  const out = new Uint8Array(44 + data.byteLength);
  const v = new DataView(out.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + data.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, format.encoding === "pcm_f32le" ? 3 : 1, true);
  v.setUint16(22, format.channels, true);
  v.setUint32(24, format.sampleRate, true);
  v.setUint32(28, format.sampleRate * format.channels * bps, true);
  v.setUint16(32, format.channels * bps, true);
  v.setUint16(34, bps * 8, true);
  ascii(36, "data");
  v.setUint32(40, data.byteLength, true);
  out.set(data, 44);
  return out;
}

/** Parses a PCM WAV file (format 1 or 3). Returns `undefined` for anything else. */
export function decodeWav(file: Uint8Array): { data: Uint8Array; format: AudioFormat } | undefined {
  if (file.byteLength < 12) return undefined;
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const tag = (off: number) =>
    String.fromCharCode(
      v.getUint8(off),
      v.getUint8(off + 1),
      v.getUint8(off + 2),
      v.getUint8(off + 3),
    );
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return undefined;
  let format: AudioFormat | undefined;
  let off = 12;
  while (off + 8 <= file.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      const code = v.getUint16(body, true);
      const bits = v.getUint16(body + 14, true);
      const encoding =
        code === 1 && bits === 16
          ? "pcm_s16le"
          : code === 3 && bits === 32
            ? "pcm_f32le"
            : undefined;
      if (encoding === undefined) return undefined;
      format = {
        encoding,
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
      };
    } else if (id === "data" && format !== undefined) {
      const end = Math.min(file.byteLength, body + size);
      return { data: file.subarray(body, end), format };
    }
    off = body + size + (size % 2);
  }
  return undefined;
}

/** Collects an async iterable of byte chunks into one buffer. */
export async function collectBytes(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const c of chunks) {
    parts.push(c);
    total += c.byteLength;
  }
  return concatBytes(parts, total);
}

export function concatBytes(parts: Uint8Array[], total?: number): Uint8Array {
  const out = new Uint8Array(total ?? parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}
