import { useAui, useAuiState } from "@assistant-ui/react";
import { type ReactElement, useCallback, useRef } from "react";
import { Composer, type ComposerProps } from "../chat/Composer.tsx";
import { t } from "../i18n/core.ts";
import { usePersona, useSlots } from "../slots.tsx";
import {
  type ComposerVoice,
  ComposerVoiceBar,
  type UseComposerVoice,
  useNoVoice,
} from "./controls.tsx";
import { useVoiceConversation } from "./conversation.ts";
import { VoiceCapsule } from "./VoiceCapsule.tsx";

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
  const hostVoice = useVoice(threadId, onText);
  const persona = usePersona();
  // Voice conversation (voice-mode-2026 §6.1): with the host's audio terminal, Voice opens the
  // capsule, which takes the composer's place (the same layoutId) until the conversation ends.
  const conversation = useVoiceConversation(threadId);
  if (conversation?.active) {
    return (
      <VoiceCapsule
        session={conversation.session}
        settings={conversation.settings}
        onTalk={conversation.talk}
        onToggleMute={conversation.toggleMute}
        onStopSpeaking={conversation.stopSpeaking}
        onEnd={conversation.end}
        levels={() => conversation.terminal.levels()}
      />
    );
  }
  const voice: ComposerVoice | null = conversation
    ? {
        dictation: hostVoice?.dictation ?? null,
        voiceMode: {
          active: false,
          label: "",
          heard: "",
          push: false,
          talking: false,
          canTalk: false,
          interruptible: false,
          toggle: conversation.start,
          pushStart: () => {},
          pushEnd: () => {},
          title: t("voice.startTitle", {
            name: persona.name,
            key: t(`voice.key.${conversation.settings.key}`),
          }),
        },
      }
    : hostVoice;
  const failed = conversation?.session.error ?? null;
  return (
    <>
      {voice ? <ComposerVoiceBar voice={voice} /> : null}
      {failed ? (
        <p
          role="status"
          className="px-3 text-callout text-label-secondary"
          data-testid="voice-error"
        >
          {failed}
        </p>
      ) : null}
      <Composer {...props} {...(voice ? { voice } : {})} />
    </>
  );
}
