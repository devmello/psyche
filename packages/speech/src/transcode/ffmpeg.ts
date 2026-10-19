import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AudioFormat,
  type ChannelType,
  PsycheError,
  type SpeechEngine,
  type TranscribeOptions,
  type Transcript,
} from "@psyche/protocol";
import { isPcm, PCM_16K_MONO, pcmDurationMs } from "../audio.ts";
import { assertOk, LocalProcessRunner, type ProcessRunner } from "../process.ts";
import { oggOpusToCaf } from "./caf.ts";
import { profileFor, type VoiceNoteProfile } from "./formats.ts";

/**
 * Voice-note transcoding with a system ffmpeg (feature N11). ffmpeg is resolved from the
 * configured path, else `ffmpeg` on PATH; it is never bundled (the Homebrew and static builds
 * are GPL; running a separate binary is aggregation, but shipping one is not our call).
 *
 * - Outbound: raw PCM on stdin → OGG/Opus or MP3 on stdout. CAF/Opus is the OGG output remuxed
 *   in-process (`caf.ts`), because ffmpeg's CAF muxer rejects Opus.
 * - Inbound: the file is written to a private temp dir and decoded from there (CAF and
 *   moov-at-end M4A cannot be decoded from a pipe) to 16 kHz mono s16le for transcription.
 * - Every call runs through a `ProcessRunner`, so the Gateway can confine ffmpeg (`srt` on
 *   macOS, the sandbox on Linux): inbound audio is untrusted input to a large C decoder.
 */

export interface EncodedVoiceNote {
  data: Uint8Array;
  mime: string;
  extension: string;
  fileName: string;
  container: VoiceNoteProfile["container"];
  bitrateKbps: number;
  durationMs: number;
  nativeVoiceNote: boolean;
}

export interface ProbeResult {
  formatName: string;
  codec: string;
  sampleRate: number;
  channels: number;
  durationMs: number;
}

export interface TranscoderOptions {
  ffmpeg?: string;
  ffprobe?: string;
  runner?: ProcessRunner;
  timeoutMs?: number;
}

const BASE = ["-hide_banner", "-loglevel", "error", "-nostdin"];

export class VoiceNoteTranscoder {
  readonly #ffmpeg: string;
  readonly #ffprobe: string;
  readonly #runner: ProcessRunner;
  readonly #timeoutMs: number;
  #available: Promise<boolean> | undefined;

  constructor(options: TranscoderOptions = {}) {
    this.#ffmpeg = options.ffmpeg ?? "ffmpeg";
    this.#ffprobe = options.ffprobe ?? "ffprobe";
    this.#runner = options.runner ?? new LocalProcessRunner();
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** `true` when ffmpeg runs and has the libopus and libmp3lame encoders. Cached. */
  available(): Promise<boolean> {
    this.#available ??= this.#runner
      .run({ argv: [this.#ffmpeg, "-hide_banner", "-encoders"], timeoutMs: 10_000 })
      .then((r) => {
        const out = new TextDecoder().decode(r.stdout);
        return r.exitCode === 0 && out.includes("libopus") && out.includes("libmp3lame");
      })
      .catch(() => false);
    return this.#available;
  }

  /** ffmpeg argv that encodes raw PCM from stdin to `profile` at `kbps` on stdout. */
  encodeArgv(format: AudioFormat, profile: VoiceNoteProfile, kbps: number): string[] {
    const input = [
      "-f",
      format.encoding === "pcm_f32le" ? "f32le" : "s16le",
      "-ar",
      String(format.sampleRate),
      "-ac",
      String(format.channels),
      "-i",
      "pipe:0",
    ];
    const common = ["-vn", "-map_metadata", "-1", "-ac", "1", "-ar", String(profile.sampleRate)];
    const codec =
      profile.container === "mp3"
        ? ["-c:a", "libmp3lame", "-b:a", `${kbps}k`, "-f", "mp3"]
        : ["-c:a", "libopus", "-b:a", `${kbps}k`, "-application", "voip", "-f", "ogg"];
    return [this.#ffmpeg, ...BASE, ...input, ...common, ...codec, "pipe:1"];
  }

  /**
   * Encodes PCM for a channel (or an explicit profile), walking down the bitrate ladder until the
   * file fits the channel's cap. Rejects `invalid_params` when even the lowest rung is too big.
   */
  async encode(
    pcm: Uint8Array,
    format: AudioFormat,
    target: ChannelType | VoiceNoteProfile,
    options: { signal?: AbortSignal } = {},
  ): Promise<EncodedVoiceNote> {
    if (!isPcm(format)) throw new PsycheError("invalid_params", "encode takes raw PCM");
    const profile = typeof target === "string" ? profileFor(target) : target;
    const durationMs = pcmDurationMs(pcm.byteLength, format);
    let lastSize = 0;
    for (const kbps of profile.bitratesKbps) {
      // Skip rungs that cannot fit (container overhead is small next to the payload).
      if ((kbps * 1000 * durationMs) / 8000 > profile.maxBytes) continue;
      const run = {
        argv: this.encodeArgv(format, profile, kbps),
        stdin: pcm,
        timeoutMs: this.#timeoutMs,
      };
      const res = assertOk(
        await this.#runner.run(
          options.signal === undefined ? run : { ...run, signal: options.signal },
        ),
        "ffmpeg encode",
      );
      const data = profile.container === "caf_opus" ? oggOpusToCaf(res.stdout) : res.stdout;
      lastSize = data.byteLength;
      if (data.byteLength <= profile.maxBytes) {
        return {
          data,
          mime: profile.mime,
          extension: profile.extension,
          fileName: profile.fileName ?? `voice-note.${profile.extension}`,
          container: profile.container,
          bitrateKbps: kbps,
          durationMs,
          nativeVoiceNote: profile.nativeVoiceNote,
        };
      }
    }
    throw new PsycheError(
      "invalid_params",
      `a ${Math.round(durationMs / 1000)} s voice note does not fit the ${profile.maxBytes} byte cap${lastSize > 0 ? ` (smallest encode ${lastSize} bytes)` : ""}`,
      { details: { durationMs, maxBytes: profile.maxBytes } },
    );
  }

  /** Decodes any audio file ffmpeg understands to 16 kHz mono s16le. */
  async decode(file: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    return this.#withTempFile(file, async (path) => {
      const argv = [
        this.#ffmpeg,
        ...BASE,
        "-i",
        path,
        "-vn",
        "-f",
        "s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        "pipe:1",
      ];
      const run = { argv, timeoutMs: this.#timeoutMs };
      const res = assertOk(
        await this.#runner.run(
          options.signal === undefined ? run : { ...run, signal: options.signal },
        ),
        "ffmpeg decode",
      );
      if (res.stdout.byteLength === 0) {
        throw new PsycheError("invalid_params", "the audio file decoded to nothing");
      }
      return res.stdout;
    });
  }

  /** ffprobe summary of the first audio stream. */
  async probe(file: Uint8Array): Promise<ProbeResult> {
    return this.#withTempFile(file, async (path) => {
      const argv = [
        this.#ffprobe,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,sample_rate,channels,duration:format=format_name,duration",
        "-of",
        "json",
        path,
      ];
      const res = assertOk(await this.#runner.run({ argv, timeoutMs: 30_000 }), "ffprobe");
      const doc = JSON.parse(new TextDecoder().decode(res.stdout)) as {
        streams?: {
          codec_name?: string;
          sample_rate?: string;
          channels?: number;
          duration?: string;
        }[];
        format?: { format_name?: string; duration?: string };
      };
      const s = doc.streams?.[0];
      if (s === undefined) throw new PsycheError("invalid_params", "no audio stream");
      const dur = Number(s.duration ?? doc.format?.duration ?? "0");
      return {
        formatName: doc.format?.format_name ?? "",
        codec: s.codec_name ?? "",
        sampleRate: Number(s.sample_rate ?? "0"),
        channels: s.channels ?? 0,
        durationMs: Number.isFinite(dur) ? Math.round(dur * 1000) : 0,
      };
    });
  }

  async #withTempFile<T>(file: Uint8Array, fn: (path: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "psyche-audio-"));
    try {
      const path = join(dir, "input");
      await writeFile(path, file, { mode: 0o600 });
      return await fn(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * Inbound voice note → transcript (Q4): decode with ffmpeg, then transcribe the 16 kHz PCM with
 * whichever engine the policy picked. Channel adapters (S10) call this.
 */
export async function transcribeVoiceNote(
  engine: SpeechEngine,
  transcoder: VoiceNoteTranscoder,
  file: Uint8Array,
  options: TranscribeOptions = {},
): Promise<Transcript> {
  const pcm = await transcoder.decode(
    file,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  return engine.transcribeFile(pcm, PCM_16K_MONO, options);
}
