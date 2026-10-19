import { NotImplementedError, type SpeechEngine } from "@psyche/protocol";

/**
 * Placeholder for the `SpeechEngine` implementation owned by S17.
 * Build against `FakeSpeechEngine` from `@psyche/testing` until this lands.
 */
export function createSpeechEngine(): SpeechEngine {
  throw new NotImplementedError("@psyche/speech", "createSpeechEngine");
}
