import type { ReactElement } from "react";
import { t } from "../i18n/core.ts";
import { usePersona } from "../slots.tsx";
import type { VoiceSession } from "./session.ts";
import type { VoiceSettings } from "./settings.ts";
import { VoiceCapsule } from "./VoiceCapsule.tsx";

/**
 * The voice HUD outside the app (docs/voice/voice-mode-2026.md §6.2): the capsule in its compact
 * form, 380 × 96 pt, top-centre, on the same material. Clicking it (anywhere but its controls)
 * opens the conversation in Psyche. The window and its placement are the desktop's.
 */
export interface VoiceHudViewProps {
  session: VoiceSession;
  settings: Pick<VoiceSettings, "mode" | "captions">;
  onTalk: (action: "begin" | "end") => void;
  onToggleMute: () => void;
  onStopSpeaking: () => void;
  onEnd: () => void;
  onOpen: () => void;
  levels?: () => { input: number; output: number };
  now?: number;
}

export function VoiceHudView({ onOpen, ...capsule }: VoiceHudViewProps): ReactElement {
  const persona = usePersona();
  return (
    <section
      className="flex h-[96px] w-[380px] items-center justify-center p-2"
      data-testid="voice-hud"
      aria-label={t("voice.hud.label", { name: persona.name })}
    >
      <div className="relative w-full">
        <VoiceCapsule {...capsule} variant="hud" />
        {/* The whole capsule opens the thread; its own buttons sit above this. */}
        <button
          type="button"
          onClick={onOpen}
          aria-label={t("voice.openThread")}
          className="absolute inset-y-0 start-0 w-16 rounded-s-[24px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="voice-hud-open"
        />
      </div>
    </section>
  );
}
