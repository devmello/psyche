/**
 * The seam between the Linux update apply step and the Gateway supervisor.
 *
 * The apply step (linux-apply.ts) needs three things from the Gateway side: get it idle
 * (`gateway.prepareUpdate`), stop it before files change, and start it again afterwards. L1 turns
 * the desktop's `GatewaySupervisor` into an interface (docs/design/linux-desktop-2026.md §2.3):
 *
 *   restart(reason): Promise<void>      stopForUpdate(): Promise<void>
 *
 * Only those two members are named here, structurally, and only this file knows their names, so a
 * later rename in L1's interface changes one adapter, not the apply step or its tests.
 */

/**
 * Why the Gateway restarts here ("update" after an update or a failed one, "build_mismatch" after
 * a rollback, when the files are not the build the data was written by): L1's own type.
 */
export type { RestartReason } from "../platform/systemd-supervisor.ts";

import type { RestartReason } from "../platform/systemd-supervisor.ts";

/** The members of L1's `GatewaySupervisor` (§2.3) that updating uses. */
export interface SupervisorForUpdate {
  restart(reason: RestartReason): Promise<void>;
  stopForUpdate(): Promise<void>;
}

/** What linux-apply.ts calls. */
export interface UpdateGateway {
  /** `gateway.prepareUpdate`: wait for running turns and tasks, then quiesce. Best effort. */
  prepare(): Promise<void>;
  /** Stop the Gateway (the systemd user unit) so its files can change. */
  stop(): Promise<void>;
  /** Start it again, on the new files (or the old ones after a failed update). */
  restart(reason: RestartReason): Promise<void>;
}

export function updateGateway(
  supervisor: SupervisorForUpdate,
  prepareUpdate: () => Promise<unknown>,
): UpdateGateway {
  return {
    prepare: async () => {
      // A Gateway too old to have the method, or not connected, just errors: the same best-effort
      // rule the macOS restart path uses (supervisor.ts `prepareRestart`).
      await prepareUpdate().catch(() => undefined);
    },
    stop: () => supervisor.stopForUpdate(),
    restart: (reason) => supervisor.restart(reason),
  };
}
