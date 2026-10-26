import type { PanelSource } from "./panel.ts";

/**
 * Cross-platform seams for the voice pop-up (docs/design/screen-ask-2026.md §9). Psyche never
 * speaks: the voice key held in any app opens the ask panel in voice mode, the renderer dictates
 * while it is held, and the answer appears as text.
 *
 * - **Voice key:** a `VoiceKeySource` reads the voice settings, watches the key system-wide and
 *   reports it to a `VoiceKeyListener`. On macOS that is `DictationService` (the helper's
 *   `dictation.watch`, keys arriving as the Gateway's `dictation.key` event, role `voice`).
 *   Another platform supplies its own source (a global hook, say) and main wires it the same way.
 * - **Screen capture:** the renderer calls the Gateway's `screen.capture`, which asks whichever
 *   node offers `screen.context` (the Mac helper today). Voice mode captures nothing.
 */
export interface VoiceKeySource {
  /** Reads the settings once paired (and again when they change) and arms the key watch. */
  load(): Promise<void>;
  /** Every Gateway event main receives (the macOS key arrives as one). */
  onEvent(event: string, payload: unknown): void;
  /** The Gateway connection dropped. */
  onDisconnected(): void;
  dispose(): void;
}

/** What a `VoiceKeySource` reports. */
export interface VoiceKeyListener {
  /** The voice key went down or up. */
  onVoiceKey(down: boolean): void;
  /** Talk with Psyche was turned on or off (the key is armed or not). */
  onVoiceEnabled(on: boolean): void;
}

/** The ask panel, as the voice pop-up uses it. */
export interface VoicePopupPanel {
  trigger(mode: "voice"): void;
  setEnabled(on: boolean, source: PanelSource): void;
}

/**
 * The voice key drives the pop-up: Talk with Psyche keeps the panel window warm (even with Ask
 * about screen off), key down opens it in voice mode, and both edges go to the panel's renderer
 * (`broadcast`) for push-to-talk.
 */
export function voicePopup(
  panel: () => VoicePopupPanel | undefined,
  broadcast: (down: boolean) => void,
): VoiceKeyListener {
  return {
    onVoiceKey: (down) => {
      if (down) panel()?.trigger("voice");
      broadcast(down);
    },
    onVoiceEnabled: (on) => panel()?.setEnabled(on, "voice"),
  };
}
