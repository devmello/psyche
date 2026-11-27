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

/**
 * The shell's dictation for the kit's composer (#690): the same `VoiceCapture` the shell's own
 * chat uses, handed to the kit as state through `UiSlots.useComposerVoice`. Must render under the shell (`useShell`), as the kit
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
  };
}
