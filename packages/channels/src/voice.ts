import type { AudioFormat } from "@psyche/protocol";

/**
 * Voice notes across channels (feature N11). Psyche only listens: inbound voice notes are
 * transcribed (Ogg/Opus 48 kHz mono on every supported channel) and Psyche does not send voice
 * notes, because it does not speak.
 */

/** Inbound voice notes are Ogg/Opus 48 kHz mono on every supported channel. */
export const INBOUND_VOICE_FORMAT: AudioFormat = {
  encoding: "opus",
  sampleRate: 48_000,
  channels: 1,
};
