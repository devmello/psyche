import type { ComposerVoice } from "@psyche/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "../context.tsx";
import {
  microphoneSource,
  VoiceCapture,
  type VoiceSegment,
  type VoiceState,
  webSpeechDictation,
} from "../voice.ts";
import { voiceModeLabel } from "../voice-mode.ts";
import { useVoiceMode } from "./VoiceModeBar.tsx";

/**
 * The shell's dictation and voice mode for the kit's composer (#690; voice-mode-2026 §8 V-U U1):
 * the same `VoiceCapture` and #481 `VoiceMode` the shell's own chat used, handed to the kit as
 * state through `UiSlots.useComposerVoice`. Must render under the shell (`useShell`), as the kit
 * chat does in the composed app.
 */
export function useShellComposerVoice(
  threadId: string | null,
  onText: (text: string) => void,
): ComposerVoice {
  const { store } = useShell();
  const [voice, setVoice] = useState<VoiceState>({ phase: "idle" });
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pushToTalk = useRef(false);
  const sink = useRef(onText);
  sink.current = onText;
  const voiceMode = useVoiceMode(store, threadId);

  const capture = useMemo(() => {
    const local = webSpeechDictation();
    return new VoiceCapture((m, p) => store.call(m, p), microphoneSource(), setVoice, {
      ...(local ? { local } : {}),
      onInterrupted: (said) => sink.current(said),
    });
  }, [store]);

  useEffect(() => {
    const off = store.tap((e) => {
      const p = e.payload as { sessionId?: string; segment?: VoiceSegment; reason?: string };
      if (typeof p?.sessionId !== "string") return;
      if (e.event === "voice.segment" && typeof p.segment?.text === "string")
        capture.onSegment(p.sessionId, p.segment);
      else if (e.event === "voice.ended" && typeof p.reason === "string")
        capture.onEnded(p.sessionId, p.reason);
    });
    return () => {
      off();
      capture.cancel();
      clearTimeout(holdTimer.current);
    };
  }, [store, capture]);

  const finish = async () => {
    const said = await capture.stop();
    if (said) sink.current(said);
  };

  const state = voiceMode.state;
  const heard =
    state.phase === "listening" ? state.partial : state.phase === "thinking" ? state.said : "";
  return {
    dictation: {
      phase: voice.phase,
      ...("partial" in voice ? { partial: voice.partial } : {}),
      ...(voice.phase === "unavailable" ? { reason: voice.reason } : {}),
      // A press longer than 300 ms is push-to-talk; a click toggles.
      down: () => {
        holdTimer.current = setTimeout(() => {
          pushToTalk.current = true;
          void capture.start(threadId ?? undefined);
        }, 300);
      },
      up: () => {
        clearTimeout(holdTimer.current);
        if (pushToTalk.current) {
          pushToTalk.current = false;
          void finish();
          return;
        }
        if (voice.phase === "listening") void finish();
        else void capture.start(threadId ?? undefined);
      },
    },
    voiceMode: voiceMode.available
      ? {
          active: state.phase !== "off",
          label: voiceModeLabel(state),
          heard,
          push: voiceMode.settings.start === "push",
          talking: state.phase === "listening",
          canTalk: state.phase !== "waiting" && state.phase !== "thinking",
          interruptible: state.phase === "speaking" && voiceMode.settings.bargeIn,
          toggle: voiceMode.toggle,
          pushStart: voiceMode.pushStart,
          pushEnd: voiceMode.pushEnd,
        }
      : null,
  };
}
