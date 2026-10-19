import { type ReactElement, useEffect, useState } from "react";
import { cn } from "../lib/utils.ts";
import { useReducedMotion } from "../theme/ThemeProvider.tsx";
import { type CreaturePose, getCreature } from "./creatures/index.tsx";

/**
 * Avatar (UI design §4.7, motion §4.5). State is derived from Tasks and the Gateway connection,
 * never set by the model; it is also given as text for assistive tech (§4.11).
 */
export type AvatarState =
  | "idle"
  | "working"
  | "needs-you"
  | "error"
  | "paused"
  | "incognito"
  | "offline";
export type AvatarSize = 20 | 28 | 40 | 64 | 160;

export const AVATAR_STATE_LABEL: Record<AvatarState, string> = {
  idle: "idle",
  working: "working",
  "needs-you": "needs you",
  error: "error",
  paused: "paused",
  incognito: "incognito",
  offline: "offline",
};

export interface AvatarProps {
  /** Persona name, used in the accessible label. */
  name: string;
  /** Bundled creature id (`moth` by default). */
  creature?: string;
  /** M2 generated avatar (`library/images/avatar/…`), shown instead of the creature when set. */
  imageSrc?: string;
  state?: AvatarState;
  size?: AvatarSize;
  /** Count on the needs-you badge. */
  count?: number;
  /** A delegated persona gets a distinct ring and the label "delegated" (architecture §4.10). */
  delegated?: boolean;
  /** Hide from assistive tech when a visible name sits next to it. */
  decorative?: boolean;
  className?: string;
}

/** The two typing frames alternate at 1.5 Hz (one swap every 333 ms). */
function useTypingFrame(active: boolean): CreaturePose {
  const [frame, setFrame] = useState<CreaturePose>("typing-a");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setFrame((f) => (f === "typing-a" ? "typing-b" : "typing-a")), 333);
    return () => clearInterval(t);
  }, [active]);
  return active ? frame : "typing-a";
}

export function Avatar({
  name,
  creature = "moth",
  imageSrc,
  state = "idle",
  size = 40,
  count,
  delegated = false,
  decorative = false,
  className,
}: AvatarProps): ReactElement {
  const reduced = useReducedMotion();
  const def = getCreature(creature);
  const working = state === "working";
  const typing = useTypingFrame(working && !reduced && size >= 28);
  // Reduced motion and the 20 px size show the static frame; working is carried by badge and text.
  const pose: CreaturePose = working && size >= 28 ? typing : "idle";
  const dashed = state === "paused" || state === "incognito";
  const ring =
    state === "needs-you"
      ? "ring-2 ring-approval"
      : state === "error"
        ? "ring-2 ring-danger"
        : delegated
          ? "ring-2 ring-info ring-offset-1 ring-offset-background"
          : "ring-1 ring-gray-6";
  const label = `${name}, ${AVATAR_STATE_LABEL[state]}${delegated ? ", delegated" : ""}`;
  const badgeSize = Math.max(8, Math.round(size * 0.32));

  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
      data-state={state}
      data-size={size}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    >
      <span
        className={cn(
          "inline-flex size-full items-center justify-center overflow-hidden rounded-full bg-gray-2",
          ring,
          dashed && "outline-2 outline-dashed outline-offset-1 outline-gray-9 ring-0",
          state === "needs-you" && !reduced && "animate-[psy-pulse-ring_1.2s_ease-in-out_infinite]",
          state === "idle" && !reduced && "animate-[psy-breathe_4s_ease-in-out_infinite]",
          (state === "error" || state === "offline") && "grayscale",
          state === "offline" && "opacity-60",
        )}
      >
        {imageSrc === undefined ? (
          <svg
            viewBox="0 0 64 64"
            width={size}
            height={size}
            aria-hidden="true"
            focusable="false"
            className="block"
          >
            {def.render(pose)}
          </svg>
        ) : (
          <img
            src={imageSrc}
            alt=""
            width={size}
            height={size}
            className="size-full object-cover"
          />
        )}
      </span>
      {state === "needs-you" && count !== undefined && count > 0 && size >= 28 ? (
        <span
          className="absolute -top-1 -right-1 inline-flex min-w-4 items-center justify-center rounded-full bg-approval px-1 text-[10px] leading-4 font-semibold text-gray-12"
          aria-hidden="true"
        >
          {count > 9 ? "9+" : count}
        </span>
      ) : null}
      {state === "error" ? (
        <span
          className="absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-background bg-danger"
          style={{ width: badgeSize, height: badgeSize }}
          aria-hidden="true"
        />
      ) : null}
      {working && (reduced || size < 28) ? (
        <span
          className="absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-background bg-accent-9"
          style={{ width: badgeSize, height: badgeSize }}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}
