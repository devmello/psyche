import { createHash } from "node:crypto";
import type { AudioFormat, ChannelAttachment, ChannelType, SpeechEngine } from "@psyche/protocol";

/**
 * Voice notes across channels (feature N11, research KQ2 voice-note matrix). Synthesize once to
 * PCM, transcode once per container: 48 kHz mono Ogg/Opus for Telegram / WhatsApp / Signal, CAF
 * (Opus) for iMessage voice bubbles, MP3 for Slack / Discord / email. The transcoder is a port
 * until S17 ships one in `@psyche/speech` (`FakeVoiceTranscoder` stands in).
 */

export type VoiceContainer = "ogg_opus" | "caf_opus" | "mp3";

export interface TranscodedAudio {
  data: Uint8Array;
  mime: string;
  name: string;
  durationMs: number;
}

export interface VoiceTranscoder {
  transcode(pcm: Uint8Array, format: AudioFormat, target: VoiceContainer): Promise<TranscodedAudio>;
}

export const VOICE_CONTAINERS: Partial<Record<ChannelType, VoiceContainer>> = {
  telegram: "ogg_opus",
  whatsapp: "ogg_opus",
  signal: "ogg_opus",
  imessage: "caf_opus",
  slack: "mp3",
  discord: "mp3",
  email: "mp3",
  webchat: "ogg_opus",
};

/** Inbound voice notes are Ogg/Opus 48 kHz mono on every supported channel. */
export const INBOUND_VOICE_FORMAT: AudioFormat = {
  encoding: "opus",
  sampleRate: 48_000,
  channels: 1,
};

export function containerFor(type: ChannelType): VoiceContainer {
  return VOICE_CONTAINERS[type] ?? "mp3";
}

interface Synthesized {
  pcm: Uint8Array;
  format: AudioFormat;
}

/**
 * Produces voice-note attachments. `synthesize` runs once per text; each container is transcoded
 * once per text and cached (bounded LRU), so one reply fanned out to Telegram and iMessage costs
 * one synthesis and two transcodes.
 */
export class VoiceNotes {
  #speech: SpeechEngine;
  #transcoder: VoiceTranscoder;
  #voice: string | undefined;
  #pcm = new Map<string, Promise<Synthesized>>();
  #encoded = new Map<string, Promise<TranscodedAudio>>();
  #max: number;

  constructor(options: {
    speech: SpeechEngine;
    transcoder: VoiceTranscoder;
    voice?: string;
    cacheSize?: number;
  }) {
    this.#speech = options.speech;
    this.#transcoder = options.transcoder;
    this.#voice = options.voice;
    this.#max = options.cacheSize ?? 16;
  }

  #remember<T>(map: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
    const hit = map.get(key);
    if (hit !== undefined) {
      map.delete(key);
      map.set(key, hit);
      return hit;
    }
    const p = make();
    p.catch(() => map.delete(key));
    map.set(key, p);
    while (map.size > this.#max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    return p;
  }

  #synthesize(text: string): Promise<Synthesized> {
    const key = createHash("sha256").update(text).digest("hex");
    return this.#remember(this.#pcm, key, async () => {
      const chunks: Uint8Array[] = [];
      let format: AudioFormat | undefined;
      const options = this.#voice === undefined ? {} : { voice: this.#voice };
      for await (const chunk of this.#speech.synthesize(text, options)) {
        chunks.push(chunk.data);
        format ??= chunk.format;
      }
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const pcm = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        pcm.set(c, off);
        off += c.byteLength;
      }
      return { pcm, format: format ?? { encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 } };
    });
  }

  async attachmentFor(text: string, type: ChannelType): Promise<ChannelAttachment> {
    const container = containerFor(type);
    const key = `${createHash("sha256").update(text).digest("hex")}:${container}`;
    const audio = await this.#remember(this.#encoded, key, async () => {
      const { pcm, format } = await this.#synthesize(text);
      return this.#transcoder.transcode(pcm, format, container);
    });
    return {
      kind: "voice",
      name: audio.name,
      mime: audio.mime,
      size: audio.data.byteLength,
      durationMs: audio.durationMs,
      data: audio.data,
    };
  }
}

/**
 * Stand-in transcoder: wraps the PCM in a recognizable header so tests can tell containers apart.
 * Produces no real audio. Replace with S17's ffmpeg / afconvert transcoder.
 */
export class FakeVoiceTranscoder implements VoiceTranscoder {
  readonly calls: { target: VoiceContainer; bytes: number }[] = [];

  async transcode(
    pcm: Uint8Array,
    format: AudioFormat,
    target: VoiceContainer,
  ): Promise<TranscodedAudio> {
    this.calls.push({ target, bytes: pcm.byteLength });
    const header = new TextEncoder().encode(
      target === "ogg_opus" ? "OggS" : target === "caf_opus" ? "caff" : "ID3\u0003",
    );
    const data = new Uint8Array(header.byteLength + Math.min(pcm.byteLength, 64));
    data.set(header, 0);
    data.set(pcm.subarray(0, 64), header.byteLength);
    const bytesPerMs = (format.sampleRate * format.channels * 2) / 1000;
    const meta = {
      ogg_opus: { mime: "audio/ogg", name: "voice.ogg" },
      caf_opus: { mime: "audio/x-caf", name: "Audio Message.caf" },
      mp3: { mime: "audio/mpeg", name: "voice.mp3" },
    }[target];
    return { data, ...meta, durationMs: Math.round(pcm.byteLength / bytesPerMs) };
  }
}
