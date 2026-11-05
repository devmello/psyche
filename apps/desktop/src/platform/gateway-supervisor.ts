/**
 * The supervisor contract (Linux desktop design §2.3). The desktop's Gateway supervisor is an
 * interface with two implementations: `LaunchdSupervisor` (macOS, `main/supervisor.ts`) and
 * `SystemdUserSupervisor` (Linux, `platform/systemd-supervisor.ts`). Other code (the updater, the
 * uninstall sheet) calls only these five methods.
 */

export type SupervisorMode = "dev" | "launchd" | "systemd" | "external" | "remote";

/** What `checkServerBuild` did: nothing to compare, same build, restarted the unit, or gave up. */
export type BuildCheck = "skipped" | "match" | "restarted" | "mismatch";

export type GatewayRunState =
  | { kind: "unknown" }
  /** `step` (launchd, systemd): installing the service, then waiting for `/healthz` (the splash). */
  | { kind: "starting"; mode: SupervisorMode; step?: "installing" | "waiting" }
  | { kind: "running"; mode: SupervisorMode; pid?: number }
  /** `logs`: the folder with gateway.{out,err}.log when the failure is worth reading them for. */
  | {
      kind: "stopped";
      mode: SupervisorMode;
      reason?: string;
      logs?: string;
      /** A restore of the pre-update data was cut short and could not be finished. */
      restoreInterrupted?: boolean;
    };

/** Why the Gateway is restarted: its build differs from this app's, or an update was applied. */
export type RestartReason = "build_mismatch" | "update";

export interface SupervisorStatus {
  /** The service is known to the manager (loaded agent, loaded unit). */
  loaded: boolean;
  /** The service is running right now. */
  active: boolean;
  pid?: number;
  /** The last exit code or result, as the manager reports it, when it is worth showing. */
  lastExit?: string;
}

export interface GatewaySupervisor {
  /** Install or refresh the unit, start it, wait for `/healthz`. `build` is the app's bundled Gateway build. */
  ensureRunning(build: string | undefined): Promise<GatewayRunState>;
  /** Build mismatch (handshake `server.build`) or update: restart the Gateway on this app's files. */
  restart(reason: RestartReason): Promise<void>;
  /** After `gateway.prepareUpdate`: stop the Gateway without uninstalling it (bootout / systemctl stop). */
  stopForUpdate(): Promise<void>;
  /** Remove the agent / disable the unit, so nothing keeps running. */
  quitEntirely(): Promise<void>;
  status(): Promise<SupervisorStatus>;
}

/** What the desktop's main process uses beyond the five methods every supervisor has. */
export interface DesktopSupervisor extends GatewaySupervisor {
  getState(): GatewayRunState;
  refresh(): Promise<void>;
  checkServerBuild(server: { build: string } | undefined): Promise<BuildCheck>;
  retryAfterUpdateFailure(opts?: { restoredByHand?: boolean }): boolean;
  /** "Close window": the Gateway keeps running. Dev children stop with the app. */
  onAppQuit(): Promise<void>;
  /** Same as `quitEntirely`, named for the "Quit Psyche entirely" menu item. */
  stopEverything(): Promise<void>;
}
