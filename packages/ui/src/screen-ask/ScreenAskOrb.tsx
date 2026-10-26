import type { ReactElement } from "react";

/**
 * The ask panel's one state indicator (docs/design/screen-ask-2026.md, "Redesign: Siri-simple"): a
 * small Psyche orb. Each state differs in shape as well as motion, so the reduced-motion frame
 * (animations stopped by the single resolver in styles/index.css) still tells them apart:
 * idle is a quiet orb, listening a wide halo, thinking a ring around it, answering a steady halo.
 */
export type OrbState = "idle" | "listening" | "thinking" | "answering";

export function ScreenAskOrb({ state }: { state: OrbState }): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-testid="screen-ask-orb"
      data-state={state}
      className="psy-orb relative block size-6 shrink-0"
    />
  );
}
