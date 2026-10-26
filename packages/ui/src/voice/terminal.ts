import type { VoiceConversationMode } from "@psyche/protocol";

/**
 * The host's audio side of a voice conversation (docs/voice/voice-mode-2026.md §3 decision 6,
 * §4.2): the renderer captures (echo cancellation on), streams `voice.conversation.audio`, plays
 * `voice.conversation.speech` with `played` reports, detects barge-in, and measures levels for
 * the lantern. The kit draws; the terminal hears and speaks. Hosts supply it as
 * `UiSlots.voiceTerminal`; stories use `FakeVoiceTerminal`.
 */
export interface VoiceTerminal {
  /**
   * Opens the microphone and calls `voice.conversation.start` on the thread (the main thread
   * when null). Resolves with the conversation id; rejects with a message the capsule shows
   * ("Psyche needs the microphone to hear you").
   */
  start(options: {
    threadId: string | null;
    mode: VoiceConversationMode;
    /** Listen (§4.9): speak this brief or check-in first (`voice.conversation.start {listen}`). */
    listen?: { notificationId: string };
  }): Promise<string>;
  /** Push-to-talk key or button down (`begin`) and up (`end`), or a tap. */
  turn(action: "begin" | "end"): void;
  /** Hands-free: close the mic (the conversation stays) or open it again. */
  mute(muted: boolean): void;
  /** Stops the reply at once (a confirmed interrupt). */
  stopSpeaking(): void;
  /**
   * Review before sending (§4.10): sends the held transcript (`text` when the owner edited it)
   * or discards it (`voice.conversation.review`).
   */
  review(utteranceId: string, action: "send" | "discard", text?: string): void;
  /** Ends the conversation; the microphone closes. */
  end(): void;
  /** Input and output RMS now, 0–1. The lantern reads it at 30 Hz. */
  levels(): { input: number; output: number };
}
