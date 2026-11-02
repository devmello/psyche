import { Loader } from "lucide-react";
import type { ReactElement } from "react";

/**
 * The ask panel's one state indicator (docs/design/screen-ask-2026.md, "Redesign: Siri-simple"): a
 * flat accent disc. Each state differs in shape as well as motion, so the reduced-motion frame
 * (animations stopped by the single resolver in styles/index.css) still tells them apart:
 * idle and answering are the plain disc, listening a disc with three level bars, thinking the
 * kit's spinner in place of the disc.
 */
export type OrbState = "idle" | "listening" | "thinking" | "answering";

const BARS = [0, 1, 2] as const;

export function ScreenAskOrb({ state }: { state: OrbState }): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-testid="screen-ask-orb"
      data-state={state}
      className="psy-orb relative flex size-6 shrink-0 items-center justify-center"
    >
      {state === "thinking" ? (
        <Loader className="size-6 text-accent-9 motion-safe:animate-spin" />
      ) : (
        <span className="absolute inset-0 rounded-full bg-accent-9" />
      )}
      {state === "listening" ? (
        <span className="relative flex h-3 items-center gap-0.5">
          {BARS.map((i) => (
            <span
              key={i}
              className="psy-orb-bar w-0.5 rounded-full bg-primary-foreground"
              style={{ height: i === 1 ? 12 : 6, animationDelay: `${i * 120}ms` }}
            />
          ))}
        </span>
      ) : null}
    </span>
  );
}
