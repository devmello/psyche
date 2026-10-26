import { useCallback, useMemo } from "react";
import { useSettings } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { useSlots } from "../slots.tsx";
import { sessionActive, useVoiceSession, type VoiceSession } from "./session.ts";
import { readVoiceSettings, type VoiceSettings } from "./settings.ts";
import type { VoiceTerminal } from "./terminal.ts";

/**
 * One device's voice conversation (docs/voice/voice-mode-2026.md §4.1, §6.1): the session from
 * the Gateway's events, the owner's settings, and the controls, which go to the host's audio
 * terminal. Null when the host has no terminal or Settings has voice conversation off.
 */
export interface VoiceConversation {
  session: VoiceSession;
  settings: VoiceSettings;
  active: boolean;
  terminal: VoiceTerminal;
  start: () => void;
  /** Push-to-talk: down and up; tap mode: a tap opens or ends the turn. */
  talk: (action: "begin" | "end") => void;
  toggleMute: () => void;
  stopSpeaking: () => void;
  end: () => void;
}

export function useVoiceConversation(threadId: string | null): VoiceConversation | null {
  const terminal = useSlots().voiceTerminal ?? null;
  const { settings: values } = useSettings();
  const settings = useMemo(() => readVoiceSettings(values), [values]);
  const [session, dispatch] = useVoiceSession();

  const start = useCallback(() => {
    if (!terminal) return;
    dispatch({ type: "starting", mode: settings.mode });
    terminal.start({ threadId, mode: settings.mode }).then(
      (conversationId) => dispatch({ type: "started", conversationId }),
      (err: unknown) =>
        dispatch({
          type: "failed",
          error: err instanceof Error && err.message ? err.message : t("voice.needsMic"),
        }),
    );
  }, [terminal, threadId, settings.mode, dispatch]);

  const talk = useCallback((action: "begin" | "end") => terminal?.turn(action), [terminal]);
  const toggleMute = useCallback(() => {
    if (!terminal) return;
    const next = !session.muted;
    terminal.mute(next);
    dispatch({ type: "muted", muted: next });
  }, [terminal, session.muted, dispatch]);
  const stopSpeaking = useCallback(() => terminal?.stopSpeaking(), [terminal]);
  const end = useCallback(() => {
    terminal?.end();
    dispatch({ type: "reset" });
  }, [terminal, dispatch]);

  if (!terminal || (!settings.enabled && !sessionActive(session))) return null;
  return {
    session,
    settings,
    active: sessionActive(session),
    terminal,
    start,
    talk,
    toggleMute,
    stopSpeaking,
    end,
  };
}
