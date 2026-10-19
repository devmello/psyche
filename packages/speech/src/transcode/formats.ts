import type { AudioFormat, ChannelType } from "@psyche/protocol";

/**
 * Voice-note formats per channel (feature N11, architecture §4.10; research KQ2 / KQ6).
 * Synthesize once to PCM, then encode per channel:
 *
 * - OGG/Opus 48 kHz mono: Telegram `sendVoice`, WhatsApp PTT (Cloud API: "OPUS codecs only…
 *   mono input only"), Signal.
 * - CAF/Opus 48 kHz mono: iMessage voice bubbles (`Audio Message.caf`, `audio/x-caf`). Apple
 *   documents only "CAF"; Opus inside is community-reported, so test with the Mac node.
 * - MP3: Slack, Discord, email, web chat (plays everywhere).
 *
 * `maxBytes` are upload caps; `bitratesKbps` is the ladder the encoder walks down when a clip
 * would exceed the cap. Caps marked unverified in the README come from vendor docs we could not
 * re-check and are deliberately conservative.
 */

export type VoiceNoteContainer = "ogg_opus" | "caf_opus" | "mp3";

export interface VoiceNoteProfile {
  container: VoiceNoteContainer;
  mime: string;
  extension: string;
  /** File name the channel expects, when it cares (iMessage). */
  fileName?: string;
  sampleRate: number;
  channels: 1;
  bitratesKbps: readonly number[];
  maxBytes: number;
  /** `false`: the channel has no native voice-note bubble; the file goes as an attachment. */
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

export const VOICE_NOTE_PROFILES: Readonly<Record<ChannelType, VoiceNoteProfile>> = {
  telegram: { ...OGG, maxBytes: 50 * MB, nativeVoiceNote: true },
  whatsapp: { ...OGG, maxBytes: 16 * MB, nativeVoiceNote: true },
  signal: { ...OGG, maxBytes: 100 * MB, nativeVoiceNote: true },
  imessage: { ...CAF, maxBytes: 100 * MB, nativeVoiceNote: true },
  slack: { ...MP3, maxBytes: 1024 * MB, nativeVoiceNote: false },
  discord: { ...MP3, maxBytes: 10 * MB, nativeVoiceNote: false },
  // 25 MB message limit minus base64 overhead.
  email: { ...MP3, maxBytes: 18 * MB, nativeVoiceNote: false },
  sms: { ...MP3, maxBytes: 5 * MB, nativeVoiceNote: false },
  webchat: { ...MP3, maxBytes: 50 * MB, nativeVoiceNote: false },
};

/** The Library copy of a read-aloud clip uses the web chat profile. */
export const LIBRARY_AUDIO_PROFILE: VoiceNoteProfile = VOICE_NOTE_PROFILES.webchat;

export function profileFor(channel: ChannelType): VoiceNoteProfile {
  return VOICE_NOTE_PROFILES[channel];
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
