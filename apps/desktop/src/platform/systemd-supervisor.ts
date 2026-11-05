import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SupervisorBase, type SupervisorOptions } from "../main/supervisor-base.ts";
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
 * `LaunchdSupervisor` and `TaskSchedulerSupervisor`: a `SupervisorBase` subclass with the same rules.
 *
 * - The unit is rewritten only when its CONTENT changes (the plist rule), so a new build, a moved
 *   AppImage or a changed key file restarts the Gateway and nothing else does.
 * - A deb/rpm install owns the unit (`/usr/lib/systemd/user/psyche-gateway.service`); the desktop
 *   then writes only a drop-in with the per-machine values (`install: "packaged"`). An AppImage
 *   writes the whole unit to `~/.config/systemd/user` (`install: "user"`).
 * - Plain quit leaves the unit running; "Quit Psyche entirely" disables it.
 * - A Gateway that already answers while our unit is not active (a terminal, another copy) is
 *   attached to, never doubled.
 * - Beyond `SupervisorBase`: `restart(reason)` and `stopForUpdate()`, the two calls the updater
 *   makes (`restart` takes `"build_mismatch" | "update"`), and `quitEntirely()`.
 */

/** Why the Gateway is restarted: its build differs from this app's, or an update was applied. */
export type RestartReason = "build_mismatch" | "update";

export interface SupervisorStatus {
  /** The unit is known to systemd. */
  loaded: boolean;
  /** The unit is running right now. */
  active: boolean;
  pid?: number;
  /** The last exit code or result, as systemd reports it, when it is worth showing. */
  lastExit?: string;
}

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

export interface SystemdOptions extends SupervisorOptions {
  /** What `ExecStart` runs: the bundled `psyched`, or the AppImage (with `gatewayArgs: ["--psyched"]`). */
  gatewayProgram?: string;
  gatewayArgs?: string[];
  /** `user`: this app writes the unit (AppImage). `packaged`: deb/rpm own it; a drop-in is written. */
  install?: "user" | "packaged";
  /** Where user units live (tests pass a tmp dir). Default `$XDG_CONFIG_HOME/systemd/user`. */
  unitDir?: string;
  memoryHigh?: string;
}

const MODE = "systemd" as const;

export class SystemdUserSupervisor extends SupervisorBase {
  protected readonly serviceMode = MODE;
  private readonly sd: SystemdOptions;

  constructor(opts: SystemdOptions) {
    super(opts);
    this.sd = opts;
  }

  private systemctl(args: string[]) {
    return this.run("systemctl", args);
  }

  private program(): string {
    return this.sd.gatewayProgram ?? "";
  }

  private install(): "user" | "packaged" {
    return this.sd.install ?? "user";
  }

  private dir(): string {
    return this.sd.unitDir ?? userUnitDir(process.env, homedir());
  }

  /** The file this app writes: the whole unit (`user`) or the drop-in next to the packaged one. */
  private managedFile(): string {
    return this.install() === "user"
      ? join(this.dir(), GATEWAY_UNIT)
      : join(this.dir(), `${GATEWAY_UNIT}.d`, "10-psyche-desktop.conf");
  }

  /** The text this build wants in {@link managedFile}, or undefined when no Gateway is bundled. */
  private async desiredContent(): Promise<string | undefined> {
    const program = this.program();
    if (program === "" || !existsSync(program)) return undefined;
    const keyFile = await this.opts.vaultKeyFile?.();
    const expected = this.opts.expectedBuild;
    const common = {
      psycheHome: this.opts.psycheHome,
      ...(expected === undefined ? {} : { build: expected }),
      ...(keyFile === undefined ? {} : { vaultKeyFile: keyFile }),
    };
    return this.install() === "user"
      ? renderGatewayUnit({
          program,
          ...(this.sd.gatewayArgs === undefined ? {} : { args: this.sd.gatewayArgs }),
          profile: "desktop",
          memoryHigh: this.sd.memoryHigh ?? DEFAULT_MEMORY_HIGH,
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
    if (this.install() !== "user") return undefined;
    const file = this.managedFile();
    return existsSync(file) ? parseGatewayUnit(readFileSync(file, "utf8"))?.program : undefined;
  }

  /** The logs are in the journal, not a folder: the reason says how to read them. */
  protected override failed(reason: string, restoreInterrupted = false): void {
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

  protected async startService(): Promise<void> {
    if ((await this.systemctl(systemctlUser.probe())).code !== 0) {
      // No user manager: a headless login without lingering, or a container.
      return this.failed("There is no systemd user session on this computer");
    }
    const content = await this.desiredContent();
    if (content === undefined) return this.failed("psyched is not bundled");
    if (this.install() === "packaged" && (await this.systemctl(systemctlUser.cat())).code !== 0) {
      return this.failed(`${GATEWAY_UNIT} is not installed; reinstall Psyche`);
    }
    const file = this.managedFile();
    const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const changed = current !== content;
    const before = await this.status();

    const other = this.installedProgram();
    if (other !== undefined && other !== this.program() && existsSync(other)) {
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
    if (before.active && !changed && (await this.healthy())) return this.refreshService();
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
    if (await this.waitHealthy()) return this.refreshService();
    const after = await this.status();
    const secs = Math.round((this.opts.healthTimeoutMs ?? 60_000) / 1000);
    this.failedToStart(
      `The Gateway did not answer within ${secs} s${after.lastExit ? ` (${after.lastExit})` : ""}. See: journalctl --user -u ${GATEWAY_UNIT}`,
    );
  }

  protected async refreshService(): Promise<void> {
    const st = await this.status();
    if (!st.loaded) return this.set({ kind: "stopped", mode: MODE, reason: "not loaded" });
    this.set(
      st.active
        ? { kind: "running", mode: MODE, ...(st.pid ? { pid: st.pid } : {}) }
        : { kind: "stopped", mode: MODE },
    );
  }

  /** A user unit must run our program; a packaged one is ours when our drop-in is there. */
  protected async ownsService(): Promise<boolean> {
    return this.install() === "user"
      ? this.installedProgram() === this.program()
      : existsSync(this.managedFile());
  }

  /**
   * Rewrites the unit when its content is stale (a new build changes `PSYCHE_BUILD`), then
   * `systemctl --user restart` starts it again whether it was running or already stopped by
   * `stopForUpdate`. False, after `failed`, when systemd would not.
   */
  protected async restartService(): Promise<boolean> {
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
      this.failed(`systemctl could not restart ${GATEWAY_UNIT} after the update`);
      return false;
    }
    return true;
  }

  /**
   * Restarts the Gateway on this app's files. For a build mismatch, stop new work and give
   * running turns a moment to settle first; after an update the caller has already done that
   * (`gateway.prepareUpdate`, `stopForUpdate`).
   */
  async restart(reason: RestartReason): Promise<void> {
    if (reason === "build_mismatch") await this.opts.prepareRestart?.().catch(() => undefined);
    this.set({ kind: "starting", mode: MODE, step: "waiting" });
    if (!(await this.restartService())) return;
    if (await this.waitHealthy()) return this.refreshService();
    this.failed("The Gateway did not come back after the update");
  }

  /** After `gateway.prepareUpdate`: stops the unit and leaves it installed. */
  async stopForUpdate(): Promise<void> {
    await this.systemctl(systemctlUser.stop());
    this.set({ kind: "stopped", mode: MODE, reason: "updating" });
  }

  protected uninstallService(): Promise<void> {
    return this.disableUnit();
  }

  /** "Quit Psyche entirely": the same as `stopEverything`, under the design's name for it. */
  quitEntirely(): Promise<void> {
    return this.stopEverything();
  }

  /**
   * Disables the unit and removes what this app wrote; the next launch installs it again. A user
   * unit that runs another copy's psyched is left alone, like the launchd agent.
   */
  private async disableUnit(): Promise<void> {
    const other = this.installedProgram();
    if (other !== undefined && other !== this.program()) return;
    await this.systemctl(systemctlUser.disableNow());
    const file = this.managedFile();
    if (existsSync(file)) {
      rmSync(file, { force: true });
      await this.systemctl(systemctlUser.daemonReload());
    }
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
