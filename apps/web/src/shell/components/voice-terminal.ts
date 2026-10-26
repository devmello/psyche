import { readVoiceSettings, useSettings } from "@psyche/ui";
import { useEffect, useMemo, useRef } from "react";
import { useShell } from "../context.tsx";
import { microphoneSource } from "../voice.ts";
import { VoiceConversationTerminal, webConversationPlayer } from "../voice-conversation.ts";

/**
 * One audio terminal per shell (voice-mode-2026 §4.2): the renderer captures and plays for the
 * kit's voice capsule. Ends any conversation when the chat unmounts, so the mic is released.
 */
export function useShellVoiceTerminal(): VoiceConversationTerminal {
  const { store } = useShell();
  const { settings } = useSettings();
  const bargeIn = useRef(true);
  bargeIn.current = readVoiceSettings(settings).bargeIn;
  const terminal = useMemo(
    () =>
      new VoiceConversationTerminal({
        call: (m, p) => store.call(m, p),
        tap: (listener) => store.tap((e) => listener(e.event, e.payload)),
        source: microphoneSource(),
        player: webConversationPlayer,
        bargeIn: () => bargeIn.current,
      }),
    [store],
  );
  useEffect(() => () => terminal.end(), [terminal]);
  return terminal;
}
