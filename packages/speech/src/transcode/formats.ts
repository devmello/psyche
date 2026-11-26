import type { AudioFormat } from "@psyche/protocol";

/**
 * Voice-note formats per container (feature N11, architecture §4.10; research KQ2 / KQ6). The
 * per-chat-channel profiles went with the channels (2026-11-25); voice memos and the Library
 * encode by container:
 *
 * - OGG/Opus 48 kHz mono.
 * - CAF/Opus 48 kHz mono (`Audio Message.caf`, `audio/x-caf`), the Messages voice-note file.
 * - MP3 (plays everywhere): the Library copy of a recording or read-aloud clip.
 *
 * `maxBytes` caps a clip; `bitratesKbps` is the ladder the encoder walks down when a clip would
 * exceed the cap.
 */

export type VoiceNoteContainer = "ogg_opus" | "caf_opus" | "mp3";

export interface VoiceNoteProfile {
  container: VoiceNoteContainer;
  mime: string;
  extension: string;
  /** File name the receiver expects, when it cares (Messages voice notes). */
  fileName?: string;
  sampleRate: number;
  channels: 1;
  bitratesKbps: readonly number[];
  maxBytes: number;
  /** `false`: no native voice-note bubble; the file goes as an attachment. */
  nativeVoiceNote: boolean;
}

const MB = 1024 * 1024;

const OGG: Omit<VoiceNoteProfile, "maxBytes" | "nativeVoiceNote"> = {
  container: "ogg_opus",
  mime: "audio/ogg",
  extension: "ogg",
  sampleRate: 48_000,
  channels: 1,
  bitratesKbps: [48, 32, 24, 16],
};

const MP3: Omit<VoiceNoteProfile, "maxBytes" | "nativeVoiceNote"> = {
  container: "mp3",
  mime: "audio/mpeg",
  extension: "mp3",
  // 44.1 kHz keeps MPEG-1 Layer III, the most compatible variant.
  sampleRate: 44_100,
  channels: 1,
  bitratesKbps: [64, 48, 32],
};

const CAF: Omit<VoiceNoteProfile, "maxBytes" | "nativeVoiceNote"> = {
  container: "caf_opus",
  mime: "audio/x-caf",
  extension: "caf",
  fileName: "Audio Message.caf",
  sampleRate: 48_000,
  channels: 1,
  bitratesKbps: [32, 24, 16],
};

export const VOICE_NOTE_PROFILES: Readonly<Record<VoiceNoteContainer, VoiceNoteProfile>> = {
  ogg_opus: { ...OGG, maxBytes: 50 * MB, nativeVoiceNote: true },
  caf_opus: { ...CAF, maxBytes: 100 * MB, nativeVoiceNote: true },
  mp3: { ...MP3, maxBytes: 50 * MB, nativeVoiceNote: false },
};

/** The Library copy of a recording or read-aloud clip: MP3. */
export const LIBRARY_AUDIO_PROFILE: VoiceNoteProfile = VOICE_NOTE_PROFILES.mp3;

export function profileFor(container: VoiceNoteContainer): VoiceNoteProfile {
  return VOICE_NOTE_PROFILES[container];
}

/** Guesses an inbound file's format from its MIME type or extension (for `AudioFormat`). */
export function inboundFormat(mimeOrName: string): AudioFormat["encoding"] | "unknown" {
  const s = mimeOrName.toLowerCase();
  if (/(ogg|opus|oga)/.test(s)) return "opus";
  if (/(mpeg|mp3)/.test(s)) return "mp3";
  if (/(caf)/.test(s)) return "caf";
  if (/(wav|wave)/.test(s)) return "wav";
  return "unknown";
}
