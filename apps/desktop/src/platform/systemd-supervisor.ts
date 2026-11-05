import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearUpdateFailure,
  defaultSleep,
  probeHealth,
  readUpdateFailure,
  waitForHealthy,
} from "./gateway-health.ts";
import type {
  BuildCheck,
  DesktopSupervisor,
  GatewayRunState,
  RestartReason,
  SupervisorStatus,
} from "./gateway-supervisor.ts";
import { execRunner, type Runner } from "./runner.ts";
import {
  DEFAULT_MEMORY_HIGH,
  GATEWAY_UNIT,
  HELPER_UNIT,
  parseGatewayUnit,
  renderGatewayDropIn,
  renderGatewayUnit,
  renderHelperUnit,
  userUnitDir,
} from "./systemd-unit.ts";

/**
 * The Gateway as a `systemd --user` unit (Linux desktop design §2.3). The Linux twin of
 * `LaunchdSupervisor`, with the same rules:
 *
 * - The unit is rewritten only when its CONTENT changes (the plist rule), so a new build, a moved
 *   AppImage or a changed key file restarts the Gateway and nothing else does.
 * - A deb/rpm install owns the unit (`/usr/lib/systemd/user/psyche-gateway.service`); the desktop
 *   then writes only a drop-in with the per-machine values (`install: "packaged"`). An AppImage
 *   writes the whole unit to `~/.config/systemd/user` (`install: "user"`).
 * - Plain quit leaves the unit running; "Quit Psyche entirely" disables it.
 * - A Gateway that already answers while our unit is not active (a terminal, another copy) is
 *   attached to, never doubled.
 */

/** `systemctl --user` argv, one place, so tests and the CLI agree on them. */
export const systemctlUser = {
  probe: () => ["--user", "show-environment"],
  daemonReload: () => ["--user", "daemon-reload"],
  enableNow: (unit = GATEWAY_UNIT) => ["--user", "enable", "--now", unit],
  disableNow: (unit = GATEWAY_UNIT) => ["--user", "disable", "--now", unit],
  start: (unit = GATEWAY_UNIT) => ["--user", "start", unit],
  stop: (unit = GATEWAY_UNIT) => ["--user", "stop", unit],
  restart: (unit = GATEWAY_UNIT) => ["--user", "restart", unit],
  isActive: (unit = GATEWAY_UNIT) => ["--user", "is-active", unit],
  cat: (unit = GATEWAY_UNIT) => ["--user", "cat", unit],
  show: (unit = GATEWAY_UNIT) => [
    "--user",
    "show",
    unit,
    "-p",
    "LoadState",
    "-p",
    "ActiveState",
    "-p",
    "MainPID",
    "-p",
    "Result",
    "-p",
    "ExecMainStatus",
  ],
  importEnvironment: (...names: string[]) => ["--user", "import-environment", ...names],
} as const;

/** Reads `systemctl --user show` output (`KEY=value` lines) into the supervisor status. */
export function parseSystemctlShow(out: string): SupervisorStatus {
  const get = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(out)?.[1]?.trim();
  const pid = Number(get("MainPID"));
  const active = get("ActiveState") === "active";
  const result = get("Result");
  const code = get("ExecMainStatus");
  const lastExit =
    result !== undefined && result !== "" && result !== "success"
      ? `${result}${code !== undefined && code !== "0" ? ` (status ${code})` : ""}`
      : code !== undefined && code !== "" && code !== "0"
        ? `status ${code}`
        : undefined;
  return {
    loaded: get("LoadState") === "loaded",
    active,
    ...(active && pid > 0 ? { pid } : {}),
    ...(lastExit === undefined ? {} : { lastExit }),
  };
}

export interface SystemdSupervisorOptions {
  psycheHome: string;
  healthUrl: string;
  /** What `ExecStart` runs: the bundled `psyched`, or the AppImage (with `args: ["--psyched"]`). */
  program: string;
  args?: string[];
  /** `user`: this app writes the unit (AppImage). `packaged`: deb/rpm own it; a drop-in is written. */
  install: "user" | "packaged";
  /** Where user units live (tests pass a tmp dir). Default `$XDG_CONFIG_HOME/systemd/user`. */
  unitDir?: string;
  /** Pass `PSYCHE_VAULT_KEY_FILE` to the Gateway (`desktopVaultKeyFile`). */
  vaultKeyFile?: () => string | undefined | Promise<string | undefined>;
  /** The Gateway build this app ships; goes into the unit as `PSYCHE_BUILD`. */
  expectedBuild?: string;
  memoryHigh?: string;
  /** Asked before a build-mismatch restart (`gateway.prepareUpdate`); errors are ignored. */
  prepareRestart?: () => Promise<unknown>;
  healthTimeoutMs?: number;
  /** Another copy's unit runs a psyched that still exists: may this copy take over? */
  confirmTakeover?: (otherProgram: string) => Promise<boolean>;
  run?: Runner;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onState?: (s: GatewayRunState) => void;
}

const MODE = "systemd" as const;

export class SystemdUserSupervisor implements DesktopSupervisor {
  private state: GatewayRunState = { kind: "unknown" };
  private readonly buildRestarts = new Set<string>();
  private buildRestart: Promise<BuildCheck> | undefined;
  private attached = false;
  private expectedBuild: string | undefined;
  private readonly opts: SystemdSupervisorOptions;
  private readonly run: Runner;

  constructor(opts: SystemdSupervisorOptions) {
    this.opts = opts;
    this.run = opts.run ?? execRunner;
    this.expectedBuild = opts.expectedBuild;
  }

  getState(): GatewayRunState {
    return this.state;
  }

  private set(s: GatewayRunState): void {
    this.state = s;
    this.opts.onState?.(s);
  }

  private healthy(): Promise<boolean> {
    return probeHealth(this.opts.healthUrl, this.opts.fetch);
  }

  private waitHealthy(): Promise<boolean> {
    return waitForHealthy({
      healthy: () => this.healthy(),
      psycheHome: this.opts.psycheHome,
      ...(this.opts.healthTimeoutMs === undefined ? {} : { timeoutMs: this.opts.healthTimeoutMs }),
      sleep: this.opts.sleep ?? defaultSleep,
    });
  }

  private systemctl(args: string[]) {
    return this.run("systemctl", args);
  }

  private dir(): string {
    return this.opts.unitDir ?? userUnitDir(process.env, homedir());
  }

  /** The file this app writes: the whole unit (`user`) or the drop-in next to the packaged one. */
  private managedFile(): string {
    return this.opts.install === "user"
      ? join(this.dir(), GATEWAY_UNIT)
      : join(this.dir(), `${GATEWAY_UNIT}.d`, "10-psyche-desktop.conf");
  }

  /** The text this build wants in {@link managedFile}, or undefined when no Gateway is bundled. */
  private async desiredContent(): Promise<string | undefined> {
    const { program, install, psycheHome } = this.opts;
    if (!existsSync(program)) return undefined;
    const keyFile = await this.opts.vaultKeyFile?.();
    const common = {
      psycheHome,
      ...(this.expectedBuild === undefined ? {} : { build: this.expectedBuild }),
      ...(keyFile === undefined ? {} : { vaultKeyFile: keyFile }),
    };
    return install === "user"
      ? renderGatewayUnit({
          program,
          ...(this.opts.args === undefined ? {} : { args: this.opts.args }),
          profile: "desktop",
          memoryHigh: this.opts.memoryHigh ?? DEFAULT_MEMORY_HIGH,
          ...common,
        })
      : renderGatewayDropIn(common);
  }

  private write(content: string): void {
    const file = this.managedFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { mode: 0o644 });
  }

  /** The program a user unit runs (`user` installs only; a drop-in does not name one). */
  private installedProgram(): string | undefined {
    if (this.opts.install !== "user") return undefined;
    const file = this.managedFile();
    return existsSync(file) ? parseGatewayUnit(readFileSync(file, "utf8"))?.program : undefined;
  }

  private failed(reason: string, restoreInterrupted = false): void {
    this.set({
      kind: "stopped",
      mode: MODE,
      reason,
      ...(restoreInterrupted ? { restoreInterrupted: true } : {}),
    });
  }

  async status(): Promise<SupervisorStatus> {
    const shown = await this.systemctl(systemctlUser.show());
    if (shown.code !== 0) return { loaded: false, active: false };
    return parseSystemctlShow(shown.stdout);
  }

  async ensureRunning(build?: string): Promise<GatewayRunState> {
    if (build !== undefined) this.expectedBuild = build;
    await this.start();
    return this.state;
  }

  private async start(): Promise<void> {
    if ((await this.systemctl(systemctlUser.probe())).code !== 0) {
      // No user manager: a headless login without lingering, or a container.
      return this.failed("There is no systemd user session on this computer");
    }
    const content = await this.desiredContent();
    if (content === undefined) return this.failed("psyched is not bundled");
    if (
      this.opts.install === "packaged" &&
      (await this.systemctl(systemctlUser.cat())).code !== 0
    ) {
      return this.failed(`${GATEWAY_UNIT} is not installed; reinstall Psyche`);
    }
    const file = this.managedFile();
    const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const changed = current !== content;
    const before = await this.status();

    const other = this.installedProgram();
    if (other !== undefined && other !== this.opts.program && existsSync(other)) {
      const takeOver = (await this.opts.confirmTakeover?.(other).catch(() => false)) ?? false;
      if (!takeOver) {
        this.attached = true;
        this.set(
          (await this.healthy())
            ? { kind: "running", mode: MODE }
            : {
                kind: "stopped",
                mode: MODE,
                reason: `Another copy of Psyche runs the Gateway (${other})`,
              },
        );
        return;
      }
    }
    if (!before.active && (await this.healthy())) {
      // Someone else serves the Gateway on this port; starting ours would crash-loop on bind.
      this.attached = true;
      this.set({ kind: "running", mode: MODE });
      return;
    }
    this.attached = false;
    if (changed) {
      this.set({ kind: "starting", mode: MODE, step: "installing" });
      this.write(content);
      await this.systemctl(systemctlUser.daemonReload());
    }
    mkdirSync(this.opts.psycheHome, { recursive: true, mode: 0o700 });
    if (before.active && !changed && (await this.healthy())) return this.refresh();
    this.set({ kind: "starting", mode: MODE, step: "waiting" });
    // An active unit whose content changed runs the old one: restart it. Otherwise `enable --now`
    // is idempotent (and starts a unit that is stopped or failed).
    const started = await this.systemctl(
      before.active && changed ? systemctlUser.restart() : systemctlUser.enableNow(),
    );
    if (started.code !== 0) {
      return this.failed(
        `systemctl could not start ${GATEWAY_UNIT}: ${(started.stderr || started.stdout).trim() || `exit ${started.code}`}`,
      );
    }
    if (before.active && changed) await this.systemctl(systemctlUser.enableNow());
    if (await this.waitHealthy()) return this.refresh();
    const after = await this.status();
    const secs = Math.round((this.opts.healthTimeoutMs ?? 60_000) / 1000);
    const known = readUpdateFailure(this.opts.psycheHome, this.expectedBuild);
    this.failed(
      known?.message ??
        `The Gateway did not answer within ${secs} s${after.lastExit ? ` (${after.lastExit})` : ""}. See: journalctl --user -u ${GATEWAY_UNIT}`,
      known?.restoreInterrupted === true,
    );
  }

  async refresh(): Promise<void> {
    const st = await this.status();
    if (!st.loaded) return this.set({ kind: "stopped", mode: MODE, reason: "not loaded" });
    this.set(
      st.active
        ? { kind: "running", mode: MODE, ...(st.pid ? { pid: st.pid } : {}) }
        : { kind: "stopped", mode: MODE },
    );
  }

  /**
   * Restarts the Gateway on this app's files. The unit is rewritten first when its content is
   * stale (a new build changes `PSYCHE_BUILD`), then `systemctl --user restart` starts it again
   * whether it was running or already stopped by `stopForUpdate`.
   */
  async restart(reason: RestartReason): Promise<void> {
    // Stop new work and give running turns a moment to settle before the process goes. After an
    // update the caller has already done this (`gateway.prepareUpdate`, `stopForUpdate`).
    if (reason === "build_mismatch") await this.opts.prepareRestart?.().catch(() => undefined);
    this.set({ kind: "starting", mode: MODE, step: "waiting" });
    const content = await this.desiredContent();
    if (content !== undefined) {
      const file = this.managedFile();
      if (!existsSync(file) || readFileSync(file, "utf8") !== content) {
        this.write(content);
        await this.systemctl(systemctlUser.daemonReload());
      }
    }
    const res = await this.systemctl(systemctlUser.restart());
    if (res.code !== 0) {
      return this.failed(`systemctl could not restart ${GATEWAY_UNIT} after the update`);
    }
    if (await this.waitHealthy()) return this.refresh();
    this.failed("The Gateway did not come back after the update");
  }

  /**
   * The Gateway's build, from the handshake challenge's `server`, against the build this app
   * shipped (the launchd rule, updates design §2.10): restart once on a mismatch; a mismatch that
   * outlives the restart means the unit runs somebody else's psyched: say so and stop trying.
   */
  checkServerBuild(server: { build: string } | undefined): Promise<BuildCheck> {
    const expected = this.expectedBuild;
    if (expected === undefined) return Promise.resolve("skipped");
    if (this.attached || this.state.kind === "starting") return Promise.resolve("skipped");
    if (server?.build === expected) {
      this.buildRestarts.delete(expected);
      return Promise.resolve("match");
    }
    if (this.buildRestart) return this.buildRestart;
    // A user unit must run our program; a packaged one is ours when our drop-in is there.
    const ours =
      this.opts.install === "user"
        ? this.installedProgram() === this.opts.program
        : existsSync(this.managedFile());
    if (!ours) return Promise.resolve("skipped");
    if (this.buildRestarts.has(expected)) {
      this.failed(`Another copy of Psyche runs the Gateway (build ${server?.build ?? "unknown"})`);
      return Promise.resolve("mismatch");
    }
    this.buildRestarts.add(expected);
    const restart = this.restart("build_mismatch")
      .then((): BuildCheck => (this.state.kind === "running" ? "restarted" : "mismatch"))
      .finally(() => {
        this.buildRestart = undefined;
      });
    this.buildRestart = restart;
    return restart;
  }

  retryAfterUpdateFailure(opts: { restoredByHand?: boolean } = {}): boolean {
    return clearUpdateFailure(this.opts.psycheHome, opts, existsSync);
  }

  /** After `gateway.prepareUpdate`: stops the unit and leaves it installed. */
  async stopForUpdate(): Promise<void> {
    await this.systemctl(systemctlUser.stop());
    this.set({ kind: "stopped", mode: MODE, reason: "updating" });
  }

  /** "Close window": the Gateway keeps running. */
  async onAppQuit(): Promise<void> {}

  async stopEverything(): Promise<void> {
    await this.quitEntirely();
  }

  /**
   * Disables the unit and removes what this app wrote; the next launch installs it again. A user
   * unit that runs another copy's psyched is left alone, like the launchd agent.
   */
  async quitEntirely(): Promise<void> {
    const other = this.installedProgram();
    if (other === undefined || other === this.opts.program) {
      await this.systemctl(systemctlUser.disableNow());
      const file = this.managedFile();
      if (existsSync(file)) {
        rmSync(file, { force: true });
        await this.systemctl(systemctlUser.daemonReload());
      }
    }
    this.set({ kind: "stopped", mode: MODE, reason: "quit" });
  }

  /**
   * The helper's unit (design §4.4). Packaged installs ship it; an AppImage has this app write it
   * to the user unit directory, under the same rewrite-only-on-change rule. Returns whether the
   * file changed (psyched then asks for a `daemon-reload` before the next start).
   */
  async ensureHelperUnit(helper: { program: string; args?: string[] }): Promise<boolean> {
    const content = renderHelperUnit({ ...helper, psycheHome: this.opts.psycheHome });
    const file = join(this.dir(), HELPER_UNIT);
    if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, { mode: 0o644 });
    await this.systemctl(systemctlUser.daemonReload());
    return true;
  }
}
