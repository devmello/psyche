import { useAui, useAuiState } from "@assistant-ui/react";
import { type ReactElement, useCallback, useRef } from "react";
import { Composer, type ComposerProps } from "../chat/Composer.tsx";
import { useSlots } from "../slots.tsx";
import { ComposerVoiceBar, type UseComposerVoice, useNoVoice } from "./controls.tsx";

/**
 * The kit's composer with the host's voice: the status line above it, the mic and Voice buttons
 * inside it, and dictated text appended to what the owner has typed.
 */
export function VoiceComposer({
  threadId,
  ...props
}: ComposerProps & { threadId: string | null }): ReactElement {
  const slots = useSlots();
  const useVoice: UseComposerVoice = slots.useComposerVoice ?? useNoVoice;
  const aui = useAui();
  const text = useAuiState((s) => (s.composer.isEditing ? s.composer.text : ""));
  const current = useRef(text);
  current.current = text;
  const onText = useCallback(
    (said: string) => {
      const prev = current.current.trim();
      aui.composer.setText(prev ? `${prev} ${said}` : said);
    },
    [aui],
  );
  const voice = useVoice(threadId, onText);
  return (
    <>
      {voice ? <ComposerVoiceBar voice={voice} /> : null}
      <Composer {...props} {...(voice ? { voice } : {})} />
    </>
  );
}
