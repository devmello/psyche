import type { ReactElement } from "react";

/**
 * The ambient "the agent is acting here" cue (smoothness-2026 C8): a thin accent edge on the
 * surface being worked on. Opacity only, so it stays on the compositor. The pulse is the
 * `psy-agent-glow` keyframes (1.2 s, linear, as the working pulse); switching `active` off fades
 * it out over `duration.short`. Under reduced motion the global rule stops the animation and the
 * edge is simply solid while active.
 *
 * Place it inside a `relative` container; it never takes pointer events.
 */
export function AgentGlow({ active }: { active: boolean }): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-testid="agent-glow"
      data-active={active ? "true" : "false"}
      className="psy-agent-glow pointer-events-none absolute inset-0 z-10 opacity-0 shadow-[inset_0_0_0_2px_var(--accent-9)] transition-opacity duration-(--duration-short) ease-(--ease-standard) data-[active=true]:opacity-100"
    />
  );
}
