import { AudioLines, Mic } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";

/**
 * Composer dictation and voice mode in the kit's chat (#690, voice-mode-2026 §8 V-U U1). The host
 * owns capture and the conversation (the shell's `VoiceCapture` and #481 `VoiceMode`, later V-G's
 * voice conversation) and hands their state to the kit through the `useComposerVoice` slot; the
 * kit draws the mic and Voice buttons in the composer and the status line above it.
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

export interface ComposerVoiceMode {
  active: boolean;
  /** The state pill: "Listening", "Thinking", "Speaking", "Needs you". */
  label: string;
  /** What Psyche heard (the owner's partial or last words). */
  heard: string;
  /** Push-to-talk: a hold-to-talk button between turns. */
  push: boolean;
  /** Holding to talk right now. */
  talking: boolean;
  /** The hold-to-talk button works (not while thinking or waiting on a card). */
  canTalk: boolean;
  /** Say "talk to interrupt" while Psyche speaks. */
  interruptible: boolean;
  toggle: () => void;
  pushStart: () => void;
  pushEnd: () => void;
}

export interface ComposerVoice {
  dictation: ComposerDictation | null;
  /** Null unless Settings → Voice & dictation turns voice conversation on. */
  voiceMode: ComposerVoiceMode | null;
}

/** The slot's hook: called with the open thread and a sink for dictated text. */
export type UseComposerVoice = (
  threadId: string | null,
  onText: (text: string) => void,
) => ComposerVoice | null;

export function useNoVoice(): ComposerVoice | null {
  return null;
}

/** The mic and Voice buttons, inside the composer capsule. */
export function ComposerVoiceButtons({
  voice,
  disabled,
  className,
}: {
  voice: ComposerVoice;
  disabled: boolean;
  className: string;
}): ReactElement {
  const { dictation, voiceMode } = voice;
  const listening = dictation?.phase === "listening" || dictation?.phase === "finishing";
  return (
    <>
      {voiceMode ? (
        <Button
          variant={voiceMode.active ? "secondary" : "ghost"}
          size="icon-sm"
          className={className}
          aria-pressed={voiceMode.active}
          aria-label={t("web.chat.voice")}
          title={t("web.chat.voiceModeTitle")}
          onClick={voiceMode.toggle}
          disabled={disabled}
          data-testid="voice-mode-toggle"
        >
          <AudioLines aria-hidden="true" />
        </Button>
      ) : null}
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
          disabled={disabled || voiceMode?.active === true}
          data-testid="mic"
        >
          <Mic aria-hidden="true" />
        </Button>
      ) : null}
    </>
  );
}

/** The line above the composer: what dictation hears, or the voice conversation's state. */
export function ComposerVoiceBar({ voice }: { voice: ComposerVoice }): ReactElement | null {
  const { dictation, voiceMode } = voice;
  if (voiceMode?.active) {
    return (
      <div
        className="flex min-h-9 items-center gap-2 rounded-full bg-surface-raised px-3 py-1 text-callout shadow-elevation-1"
        data-testid="voice-mode"
      >
        <span role="status" aria-live="polite" className="shrink-0 font-medium">
          {voiceMode.label}
          {voiceMode.interruptible ? t("web.voiceMode.talkToInterrupt") : ""}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-label-secondary"
          title={t("web.voiceMode.heard")}
        >
          {voiceMode.heard}
        </span>
        {voiceMode.push ? (
          <Button
            size="xs"
            variant="outline"
            aria-pressed={voiceMode.talking}
            disabled={!voiceMode.canTalk}
            onPointerDown={voiceMode.pushStart}
            onPointerUp={voiceMode.pushEnd}
            onPointerLeave={voiceMode.pushEnd}
            data-testid="voice-mode-talk"
          >
            {t("web.voiceMode.holdToTalk")}
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={voiceMode.toggle} data-testid="voice-mode-end">
          {t("web.voiceMode.end")}
        </Button>
      </div>
    );
  }
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
