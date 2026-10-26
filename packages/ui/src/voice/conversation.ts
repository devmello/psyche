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
  start: (options?: { listen?: { notificationId: string } }) => void;
  /** Push-to-talk: down and up; tap mode: a tap opens or ends the turn. */
  talk: (action: "begin" | "end") => void;
  toggleMute: () => void;
  stopSpeaking: () => void;
  /** Review before sending: send the held words (as edited) or discard them. */
  review: (action: "send" | "discard", text?: string) => void;
  end: () => void;
}

export function useVoiceConversation(
  threadId: string | null,
  /** `listen`: usable for Listen (§4.9) while "Talk with Psyche" is off, unless the brief is off. */
  options: { listen?: boolean } = {},
): VoiceConversation | null {
  const terminal = useSlots().voiceTerminal ?? null;
  const { settings: values } = useSettings();
  const settings = useMemo(() => readVoiceSettings(values), [values]);
  const [session, dispatch] = useVoiceSession();

  const start = useCallback(
    (o?: { listen?: { notificationId: string } }) => {
      if (!terminal) return;
      dispatch({ type: "starting", mode: settings.mode });
      terminal
        .start({ threadId, mode: settings.mode, ...(o?.listen ? { listen: o.listen } : {}) })
        .then(
          (conversationId) => dispatch({ type: "started", conversationId }),
          (err: unknown) =>
            dispatch({
              type: "failed",
              error: err instanceof Error && err.message ? err.message : t("voice.needsMic"),
            }),
        );
    },
    [terminal, threadId, settings.mode, dispatch],
  );

  const talk = useCallback((action: "begin" | "end") => terminal?.turn(action), [terminal]);
  const toggleMute = useCallback(() => {
    if (!terminal) return;
    const next = !session.muted;
    terminal.mute(next);
    dispatch({ type: "muted", muted: next });
  }, [terminal, session.muted, dispatch]);
  const stopSpeaking = useCallback(() => terminal?.stopSpeaking(), [terminal]);
  const draftId = session.draft?.utteranceId ?? null;
  const review = useCallback(
    (action: "send" | "discard", text?: string) => {
      if (terminal && draftId) terminal.review(draftId, action, text);
    },
    [terminal, draftId],
  );
  const end = useCallback(() => {
    terminal?.end();
    dispatch({ type: "reset" });
  }, [terminal, dispatch]);

  const allowed = settings.enabled || (options.listen === true && settings.brief !== "off");
  if (!terminal || (!allowed && !sessionActive(session))) return null;
  return {
    session,
    settings,
    active: sessionActive(session),
    terminal,
    start,
    talk,
    toggleMute,
    stopSpeaking,
    review,
    end,
  };
}
