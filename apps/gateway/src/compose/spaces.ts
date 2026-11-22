import type { Automation } from "@psyche/protocol";
import { spacesHandlers } from "../spaces/handlers.ts";
import type { ComposedPart } from "./services.ts";

/** The scheduler as Spaces uses it: pause and resume an automation, and read it back. */
export interface SpacesScheduler {
  update(id: string, patch: { enabled: boolean }): Promise<unknown>;
  get(id: string): Promise<Automation | undefined>;
}

/**
 * Spaces (docs/design/spaces-2026.md): the `spaces.*` handlers over the Gateway's own database.
 * Archiving pauses a Space's automations through the scheduler, so their next run is recomputed
 * when the Space is restored.
 */
export function composeSpaces(deps: { scheduler: SpacesScheduler }): ComposedPart {
  const { scheduler } = deps;
  return {
    handlers: spacesHandlers({
      automations: {
        setEnabled: (id, enabled) => scheduler.update(id, { enabled }),
        get: (id) => scheduler.get(id),
      },
    }),
  };
}
