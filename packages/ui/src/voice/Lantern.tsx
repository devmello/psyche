import { useReducedMotionConfig } from "motion/react";
import { type CSSProperties, type ReactElement, useEffect, useRef } from "react";
import { Avatar } from "../avatar/Avatar.tsx";
import { cn } from "../lib/utils.ts";

/**
 * The lantern (docs/voice/voice-mode-2026.md §6.3): the moth's lantern from the app icon and the
 * splash as the voice's face, a radial accent glow behind the 40 px avatar. While listening it
 * follows the owner's voice, while speaking Psyche's (warmer, accent-10), driven by RMS the
 * client measures (30 Hz, 80 ms attack, 250 ms release). Heard: one 120 ms brighten. Thinking:
 * the shared 1.2 s working pulse. Needs you: still, with a ring draining over the listening
 * window. Off: fades out in 280 ms.
 *
 * One layer, `opacity` and `transform` only, written straight to the element (no React render
 * per frame). Reduced motion: no scale, no level following, no pulse; three still opacities and
 * the state in words beside it (the capsule's label).
 */

export type LanternState = "listening" | "heard" | "thinking" | "speaking" | "waiting" | "off";

export interface LanternProps {
  state: LanternState;
  /** Current input and output RMS, 0–1 (the terminal's meter). */
  levels?: () => { input: number; output: number };
  name: string;
  creature?: string;
  imageSrc?: string;
  /** Needs you: the listening window's length and when it opened (epoch ms). */
  windowMs?: number | null;
  windowAt?: number | null;
  /** A fixed clock for stories (the ring's remaining fraction). */
  now?: number;
  className?: string;
}

const FRAME_MS = 1000 / 30;
const ATTACK_MS = 80;
const RELEASE_MS = 250;
/** RMS at which the glow is at its fullest (speech peaks around 0.1–0.3). */
const FULL_RMS = 0.2;

/** Still opacities: the resting states, and every state under reduced motion. */
export const LANTERN_STILL: Record<LanternState, number> = {
  listening: 0.35,
  heard: 0.6,
  thinking: 0.6,
  speaking: 0.8,
  waiting: 0.6,
  off: 0,
};

/** One envelope step: rises over ~80 ms, falls over ~250 ms (pure, for tests). */
export function envelope(prev: number, rms: number, dtMs: number): number {
  const tau = rms > prev ? ATTACK_MS : RELEASE_MS;
  return prev + (rms - prev) * (1 - Math.exp(-dtMs / tau));
}

/** Glow from a level, 0–1: scale 1.00–1.12 and opacity 35–85 % (§6.3). */
export function glowFor(level: number): { scale: number; opacity: number } {
  const n = Math.min(1, Math.max(0, level / FULL_RMS));
  return { scale: 1 + 0.12 * n, opacity: 0.35 + 0.5 * n };
}

export function Lantern({
  state,
  levels,
  name,
  creature,
  imageSrc,
  windowMs,
  windowAt,
  now,
  className,
}: LanternProps): ReactElement {
  const reduce = useReducedMotionConfig() === true;
  const glow = useRef<HTMLSpanElement | null>(null);
  const read = useRef(levels);
  read.current = levels;
  const following =
    !reduce && levels !== undefined && (state === "listening" || state === "speaking");

  // Level following: one rAF loop at 30 Hz writing transform and opacity to the glow layer.
  useEffect(() => {
    const el = glow.current;
    if (!following || !el) return;
    let env = 0;
    let last = 0;
    let frame = requestAnimationFrame(function tick(ts) {
      if (ts - last >= FRAME_MS) {
        const dt = last === 0 ? FRAME_MS : ts - last;
        last = ts;
        const l = read.current?.() ?? { input: 0, output: 0 };
        env = envelope(env, state === "speaking" ? l.output : l.input, dt);
        const g = glowFor(env);
        el.style.transform = `scale(${g.scale.toFixed(3)})`;
        el.style.opacity = g.opacity.toFixed(3);
      }
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      el.style.transform = "";
      el.style.opacity = "";
    };
  }, [following, state]);

  const remaining =
    state === "waiting" && windowMs && windowAt
      ? Math.max(0, Math.min(1, 1 - ((now ?? Date.now()) - windowAt) / windowMs))
      : null;
  const style: CSSProperties = { opacity: LANTERN_STILL[state] };
  return (
    <span
      className={cn("relative inline-flex size-10 shrink-0 items-center justify-center", className)}
      data-lantern={state}
      data-reduced={reduce || undefined}
    >
      <span
        ref={glow}
        aria-hidden="true"
        className={cn(
          "psy-voice-glow pointer-events-none absolute -inset-3 rounded-full",
          state === "speaking" && "psy-voice-glow-warm",
          !reduce && state === "heard" && "psy-voice-heard",
          !reduce && state === "thinking" && "psy-voice-thinking",
          state === "off" && "psy-voice-off",
        )}
        style={style}
        data-glow=""
      />
      <Avatar
        name={name}
        {...(creature ? { creature } : {})}
        {...(imageSrc ? { imageSrc } : {})}
        size={40}
        decorative
        className="relative"
      />
      {remaining !== null ? (
        <svg
          aria-hidden="true"
          viewBox="0 0 48 48"
          className="pointer-events-none absolute -inset-1 size-12 -rotate-90"
          data-ring=""
        >
          <circle
            cx="24"
            cy="24"
            r="22"
            fill="none"
            strokeWidth="2.5"
            className="stroke-approval"
            pathLength={100}
            strokeDasharray="100"
            strokeDashoffset={100 - remaining * 100}
            style={
              reduce || !windowMs
                ? undefined
                : {
                    animation: `psy-voice-drain ${Math.round(remaining * windowMs)}ms linear forwards`,
                    ["--psy-ring-from" as string]: `${100 - remaining * 100}`,
                  }
            }
          />
        </svg>
      ) : null}
    </span>
  );
}
