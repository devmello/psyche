import { Mic } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";

/**
 * Composer dictation in the kit's chat (#690). The host owns capture (the shell's `VoiceCapture`)
 * and hands its state to the kit through the `useComposerVoice` slot; the kit draws the mic
 * button in the composer and the status line above it. Psyche does not speak: voice is
 * speech-to-text, and answers appear as text.
 */

export interface ComposerDictation {
  phase: "idle" | "starting" | "listening" | "finishing" | "unavailable";
  /** Everything heard so far while listening. */
  partial?: string;
  /** Why dictation can't start (no microphone, no engine). */
  reason?: string;
  /** The mic button: a press longer than 300 ms is push-to-talk, a click toggles. */
  down: () => void;
  up: () => void;
}

export interface ComposerVoice {
  dictation: ComposerDictation | null;
}

/** The slot's hook: called with the open thread and a sink for dictated text. */
export type UseComposerVoice = (
  threadId: string | null,
  onText: (text: string) => void,
) => ComposerVoice | null;

export function useNoVoice(): ComposerVoice | null {
  return null;
}

/** The mic button, inside the composer capsule. */
export function ComposerVoiceButtons({
  voice,
  disabled,
  className,
}: {
  voice: ComposerVoice;
  disabled: boolean;
  className: string;
}): ReactElement {
  const { dictation } = voice;
  const listening = dictation?.phase === "listening" || dictation?.phase === "finishing";
  return (
    <>
      {dictation ? (
        <Button
          variant={listening ? "secondary" : "ghost"}
          size="icon-sm"
          className={cn(className, listening && "text-danger-text")}
          aria-pressed={listening}
          aria-label={t("chat.composer.dictate")}
          title={t("web.chat.dictateTitle")}
          onPointerDown={dictation.down}
          onPointerUp={dictation.up}
          onKeyDown={(e) => {
            // Keyboard: Space or Return toggles (no hold on a key press).
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              dictation.down();
              dictation.up();
            }
          }}
          disabled={disabled}
          data-testid="mic"
        >
          <Mic aria-hidden="true" />
        </Button>
      ) : null}
    </>
  );
}

/** The line above the composer: what dictation hears. */
export function ComposerVoiceBar({ voice }: { voice: ComposerVoice }): ReactElement | null {
  const { dictation } = voice;
  if (dictation?.phase === "unavailable" && dictation.reason) {
    return (
      <p role="status" className="px-3 text-callout text-label-secondary">
        {dictation.reason}
      </p>
    );
  }
  if (dictation?.phase === "listening" || dictation?.phase === "finishing") {
    return (
      <p
        role="status"
        aria-live="polite"
        className="flex min-w-0 items-center gap-2 px-3 text-callout text-label-secondary"
        data-testid="dictation-status"
      >
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-danger" />
        <span className="shrink-0">{t("web.chat.listening")}</span>
        {dictation.partial ? (
          <span className="min-w-0 truncate text-label-primary">{dictation.partial}</span>
        ) : null}
      </p>
    );
  }
  return null;
}
