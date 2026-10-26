import { AudioLines, Mic, MicOff, Square, X } from "lucide-react";
import * as m from "motion/react-m";
import { type KeyboardEvent, type ReactElement, useEffect, useState } from "react";
import { GlassSurface } from "../components/glass-surface.tsx";
import { StatusGlyph, stepStatusKind } from "../components/status.tsx";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { motionSpring, spring } from "../motion/tokens.ts";
import { usePersona } from "../slots.tsx";
import { Lantern, type LanternState } from "./Lantern.tsx";
import { micOn, type VoiceSession } from "./session.ts";
import type { VoiceSettings } from "./settings.ts";

/**
 * The voice capsule (docs/voice/voice-mode-2026.md §6.1): the composer morphs into it (the same
 * `layoutId`, `spring.smooth`; a crossfade under reduced motion). Inside: the lantern, one caption
 * line, the step line while it works, the controls (hold to talk / tap to talk, Mute, Stop
 * speaking, End) and the Mic on chip, which always matches capture. Waiting on an approval it
 * says "Say 'send it' or 'cancel'" while a 10 s ring drains on the lantern.
 *
 * Keyboard (§4.10): Space holds to talk (push) or taps (tap), Esc ends, ⌘. stops speaking. State
 * changes are announced politely; Psyche's caption is not, so speech isn't heard twice.
 */

export interface VoiceCapsuleProps {
  session: VoiceSession;
  settings: Pick<VoiceSettings, "mode" | "captions">;
  onTalk: (action: "begin" | "end") => void;
  onToggleMute: () => void;
  onStopSpeaking: () => void;
  onEnd: () => void;
  levels?: () => { input: number; output: number };
  /** A fixed clock for stories (the readback window). */
  now?: number;
  /** Compact form for the HUD (no step line, smaller controls). */
  variant?: "capsule" | "hud";
  className?: string;
}

/** The lantern's state for a session phase. */
export function lanternState(s: VoiceSession): LanternState {
  if (s.phase === "idle") return "off";
  if (s.phase === "starting") return "listening";
  if (s.phase === "ended") return "off";
  if (s.phase === "listening" && s.muted) return "off";
  return s.phase;
}

/** The state in words (the polite live region, and beside the lantern under reduced motion). */
export function stateLabel(s: VoiceSession, mode: VoiceSettings["mode"]): string {
  if (s.phase === "starting") return t("voice.state.starting");
  if (s.muted) return t("voice.state.muted");
  if (s.phase === "listening" && !s.listening)
    return mode === "tap" ? t("voice.state.readyTap") : t("voice.state.ready");
  switch (s.phase) {
    case "listening":
      return t("voice.state.listening");
    case "heard":
      return t("voice.state.heard");
    case "thinking":
      return t("voice.state.thinking");
    case "speaking":
      return t("voice.state.speaking");
    case "waiting":
      return t("voice.state.waiting");
    default:
      return "";
  }
}

function useSecondsLeft(s: VoiceSession, now?: number): number | null {
  const [clock, setClock] = useState(() => Date.now());
  const counting = s.phase === "waiting" && s.windowMs !== null && s.windowAt !== null;
  useEffect(() => {
    if (!counting || now !== undefined) return;
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, [counting, now]);
  if (!counting || s.windowMs === null || s.windowAt === null) return null;
  return Math.max(0, Math.ceil((s.windowAt + s.windowMs - (now ?? clock)) / 1000));
}

export function VoiceCapsule({
  session,
  settings,
  onTalk,
  onToggleMute,
  onStopSpeaking,
  onEnd,
  levels,
  now,
  variant = "capsule",
  className,
}: VoiceCapsuleProps): ReactElement {
  const persona = usePersona();
  const [holding, setHolding] = useState(false);
  const seconds = useSecondsLeft(session, now);
  const label = stateLabel(session, settings.mode);
  const mic = micOn(session);
  const speaking = session.phase === "speaking";
  const busy = session.phase === "thinking" || session.phase === "starting";
  const readback = session.phase === "waiting" && session.reason === "approval";
  const caption = settings.captions ? session.caption : null;

  const press = () => {
    if (settings.mode === "push") {
      setHolding(true);
      onTalk("begin");
    }
  };
  const release = () => {
    if (settings.mode === "push" && holding) {
      setHolding(false);
      onTalk("end");
    } else if (settings.mode === "tap") onTalk(session.listening ? "end" : "begin");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onEnd();
    } else if (e.key === "." && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onStopSpeaking();
    } else if (e.key === " " && !e.repeat && (e.target as HTMLElement).tagName !== "BUTTON") {
      e.preventDefault();
      press();
    }
  };
  const onKeyUp = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === " " && (e.target as HTMLElement).tagName !== "BUTTON") {
      e.preventDefault();
      release();
    }
  };

  const hud = variant === "hud";
  const talkLabel = holding
    ? t("voice.talkingNow")
    : settings.mode === "push"
      ? t("voice.holdToTalk")
      : t("voice.tapToTalk");
  return (
    <m.div
      layoutId="psyche-composer"
      transition={motionSpring(spring.smooth)}
      className={cn("relative", className)}
      data-testid="voice-capsule"
      data-phase={session.phase}
    >
      <GlassSurface impl="refraction" radius={hud ? 24 : 32} as="section">
        {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of controls, not a form fieldset */}
        <div
          role="group"
          aria-label={t("voice.capsule.label", { name: persona.name })}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          className={cn("flex items-center gap-3 outline-none", hud ? "px-3 py-2" : "px-3 py-2.5")}
        >
          <Lantern
            state={lanternState(session)}
            name={persona.name}
            creature={persona.creature}
            {...(persona.imageSrc ? { imageSrc: persona.imageSrc } : {})}
            {...(levels ? { levels } : {})}
            windowMs={session.windowMs}
            windowAt={session.windowAt}
            {...(now === undefined ? {} : { now })}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p
              role="status"
              aria-live="polite"
              className="text-callout font-medium text-label-secondary"
            >
              {label}
              {readback && seconds !== null ? (
                <span className="font-normal tabular-nums">
                  {" · "}
                  {t("voice.readbackWindow", { seconds })}
                </span>
              ) : null}
            </p>
            {readback ? (
              <p className="truncate text-body text-label-primary" data-testid="voice-readback">
                {t("voice.readback", {
                  approve: t("voice.readbackApprove"),
                  deny: t("voice.readbackDeny"),
                })}
              </p>
            ) : session.phase === "waiting" && session.reason === "question" ? (
              <p className="truncate text-body text-label-primary">{t("voice.question")}</p>
            ) : caption?.text ? (
              <p
                dir="auto"
                // Psyche's sentence isn't announced again: it is being spoken.
                aria-hidden={caption.role === "agent" ? true : undefined}
                className={cn(
                  "truncate text-body",
                  caption.role === "owner" ? "text-label-secondary" : "text-label-primary",
                )}
                data-testid="voice-caption"
                data-role={caption.role}
              >
                {caption.text}
              </p>
            ) : session.reason === "no_speech" ? (
              <p className="truncate text-body text-label-secondary">{t("voice.noSpeech")}</p>
            ) : null}
            {!hud && session.step && busy ? (
              <p
                className="flex min-w-0 items-center gap-1.5 text-callout text-label-secondary"
                data-testid="voice-step"
              >
                <StatusGlyph
                  status={stepStatusKind(
                    session.step.status === "ok"
                      ? "ok"
                      : session.step.status === "failed"
                        ? "failed"
                        : "running",
                  )}
                  className="size-3.5 shrink-0"
                />
                <span className="truncate">{session.step.label}</span>
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {settings.mode !== "handsfree" ? (
              <Button
                size={hud ? "icon-sm" : "sm"}
                variant={holding || session.listening ? "default" : "secondary"}
                {...(hud ? { "aria-label": talkLabel } : {})}
                aria-pressed={holding || (settings.mode === "tap" && session.listening)}
                aria-keyshortcuts="Space"
                disabled={busy}
                onPointerDown={press}
                onPointerUp={release}
                onPointerLeave={() => {
                  if (holding) release();
                }}
                onKeyDown={(e) => {
                  if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                    e.preventDefault();
                    press();
                  }
                }}
                onKeyUp={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    release();
                  }
                }}
                data-testid="voice-talk"
              >
                <AudioLines aria-hidden="true" />
                {hud ? null : talkLabel}
              </Button>
            ) : (
              <Button
                size={hud ? "icon-sm" : "sm"}
                variant="ghost"
                aria-pressed={session.muted}
                {...(hud ? { "aria-label": session.muted ? t("voice.unmute") : t("voice.mute") } : {})}
                onClick={onToggleMute}
                data-testid="voice-mute"
              >
                {session.muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
                {hud ? null : session.muted ? t("voice.unmute") : t("voice.mute")}
              </Button>
            )}
            {speaking ? (
              <Button
                size={hud ? "icon-sm" : "sm"}
                variant="ghost"
                aria-keyshortcuts="Meta+."
                {...(hud ? { "aria-label": t("voice.stopSpeaking") } : {})}
                onClick={onStopSpeaking}
                data-testid="voice-stop-speaking"
              >
                <Square aria-hidden="true" className="size-3 fill-current" />
                {hud ? null : t("voice.stopSpeaking")}
              </Button>
            ) : null}
            <Button
              size={hud ? "icon-xs" : "icon-sm"}
              variant="ghost"
              aria-label={t("voice.end")}
              aria-keyshortcuts="Escape"
              onClick={onEnd}
              data-testid="voice-end"
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full py-0.5 text-subheadline",
              hud ? "px-1.5" : "px-2",
              mic ? "bg-danger-surface text-danger-text" : "bg-fill-tertiary text-label-tertiary",
            )}
            data-testid="mic-chip"
            data-on={mic || undefined}
          >
            <span
              aria-hidden="true"
              className={cn("size-1.5 rounded-full", mic ? "bg-danger" : "bg-label-tertiary")}
            />
            <span className={hud ? "sr-only" : undefined}>
              {mic ? t("voice.micOn") : t("voice.micOff")}
            </span>
          </span>
        </div>
      </GlassSurface>
    </m.div>
  );
}
