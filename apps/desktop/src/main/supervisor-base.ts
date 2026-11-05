import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureOwnerOnly } from "@psyche/hostfs";

/**
 * Gateway lifecycle (feature A7, architecture §3.1), the part every platform shares. The window is
 * only a client: work continues when it closes because the Gateway runs on its own.
 *
 * - `dev`: unpackaged builds spawn `psyched` from `apps/gateway` as a child (stopped on quit),
 *   unless a Gateway already answers `/healthz`.
 * - `launchd` (macOS, `supervisor.ts`) and `taskscheduler` (Windows, `supervisor-windows.ts`):
 *   packaged builds register the bundled Gateway with the OS so it runs at login and is kept
 *   alive, start it and wait for `/healthz`. Plain quit leaves it running; "Quit Psyche entirely"
 *   uninstalls it.
 * - `systemd` (Linux, `platform/systemd-supervisor.ts`): a `systemd --user` unit, same job.
 * - `external`: never start anything (tests, a Gateway on another machine via SSH tunnel).
 * - `remote`: the active saved Gateway is on another computer (remote-gateway design §1.2). Like
 *   `external` it starts nothing and only reports whether the Gateway answers, and it also leaves
 *   this computer's own Gateway registration alone: "Quit Psyche entirely" in Remote mode must not
 *   stop the Gateway whose automations keep running here.
 */

export type SupervisorMode = "dev" | "launchd" | "taskscheduler" | "systemd" | "external" | "remote";

/** The OS-registered modes: the Gateway outlives the app. */
export type ServiceMode = "launchd" | "taskscheduler" | "systemd";

/** What `checkServerBuild` did: nothing to compare, same build, restarted the service, or gave up. */
export type BuildCheck = "skipped" | "match" | "restarted" | "mismatch";

export type GatewayRunState =
  | { kind: "unknown" }
  /** `step` (service modes): registering with the OS, then waiting for `/healthz` (the splash). */
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

/** The packaged mode for this OS: launchd on macOS, Task Scheduler on Windows, systemd on Linux. */
export function serviceModeFor(platform: NodeJS.Platform): ServiceMode {
  if (platform === "win32") return "taskscheduler";
  return platform === "linux" ? "systemd" : "launchd";
}

export function chooseMode(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
  platform: NodeJS.Platform = process.platform,
): SupervisorMode {
  const forced = env.PSYCHE_GATEWAY_MODE;
  if (forced === "dev" || forced === "external") return forced;
  // A forced service mode only counts on its own OS: launchd on Windows would never start.
  if (forced === "launchd" || forced === "taskscheduler" || forced === "systemd")
    return forced === serviceModeFor(platform) ? forced : serviceModeFor(platform);
  return isPackaged ? serviceModeFor(platform) : "dev";
}

/**
 * The packaged desktop's vault key slot: a 0600 random key file under `$PSYCHE_HOME/secrets/`,
 * like server mode, because an ad-hoc helper has no keychain access group (keychain.* answers
 * missing_entitlement). Created on first use; never when the vault already exists with another
 * slot (switching would lock the owner out). Windows has no modes: there the folder and the file
 * get an owner-only ACL unless they already have one (a home under the profile inherits it); the
 * Gateway's key-file slot refuses a file others can read (@psyche/hostfs `isOwnerOnly`).
 */
export function desktopVaultKeyFile(
  psycheHome: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const keyFile = join(psycheHome, "secrets", "vault.key");
  const slotsFile = join(psycheHome, "vault", "slots.json");
  if (existsSync(slotsFile)) {
    try {
      const slots = (JSON.parse(readFileSync(slotsFile, "utf8")) as { slots?: object }).slots;
      if (!slots || !("key_file" in slots)) return undefined;
    } catch {
      return undefined;
    }
  }
  if (!existsSync(keyFile)) {
    mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
    if (platform === "win32") ensureOwnerOnly(dirname(keyFile), platform);
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
  }
  if (platform === "win32") ensureOwnerOnly(keyFile, platform);
  return keyFile;
}

/**
 * The `build` of the bundled Gateway (`psyched/build-info.json` in the app's resources, written by
 * deploy/scripts/build-psyched.mjs), or undefined when there is no such file or it names none.
 */
export function readBundledBuild(buildInfoPath: string): string | undefined {
  try {
    const build = (JSON.parse(readFileSync(buildInfoPath, "utf8")) as { build?: unknown }).build;
    return typeof build === "string" && build.trim() !== "" ? build.trim().slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}

export type Runner = (
  file: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const execRunner: Runner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface SupervisorOptions {
  mode: SupervisorMode;
  psycheHome: string;
  healthUrl: string;
  /** dev: path of the `apps/gateway` package. */
  gatewayDir?: string;
  /**
   * Pass `PSYCHE_VAULT_KEY_FILE` to the Gateway (`desktopVaultKeyFile`): launchd in the plist,
   * Task Scheduler through `run\gateway-service.json` (supervisor-windows.ts).
   */
  vaultKeyFile?: () => string | undefined | Promise<string | undefined>;
  /**
   * Service modes: the build of the Gateway this app ships (`build` in the bundled
   * `psyched/build-info.json`). It reaches the Gateway as `PSYCHE_BUILD` (launchd in the plist,
   * Task Scheduler through `run\gateway-service.json`), so a new build changes what is registered
   * and the Gateway is restarted, and `checkServerBuild` compares it with what a running Gateway
   * reports in the handshake. Unset (a bundle without build info): neither happens.
   */
  expectedBuild?: string;
  /**
   * Service modes: asked before the Gateway is restarted for a build mismatch, so running turns
   * and tasks are not killed mid-flight (`gateway.prepareUpdate` on the connected Gateway). Best
   * effort: a Gateway too old to have the method just answers an error, which is ignored.
   */
  prepareRestart?: () => Promise<unknown>;
  /** Service modes: how long to wait for `/healthz` after starting it (default 60 s). */
  healthTimeoutMs?: number;
  /**
   * Service modes: two copies of Psyche (an installed one and a build in out/, say) share the
   * registration. When it runs another copy's Gateway that still exists, ask before pointing it
   * here; without an answer (or on "no") this copy attaches to that Gateway.
   */
  confirmTakeover?: (otherProgram: string) => Promise<boolean>;
  run?: Runner;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onState?: (s: GatewayRunState) => void;
  /** Test seam: the platform the dev child is spawned for. */
  platform?: NodeJS.Platform;
}

/** What main.ts and the IPC handlers use, whatever the OS. */
export interface Supervisor {
  getState(): GatewayRunState;
  /** Makes sure a Gateway runs (registering it with the OS when packaged). */
  ensureRunning(): Promise<void>;
  refresh(): Promise<void>;
  /** "Close window" / plain quit: the Gateway keeps running. Dev children stop with the app. */
  onAppQuit(): Promise<void>;
  /** "Quit Psyche entirely": stops and unregisters the Gateway so nothing keeps running. */
  stopEverything(): Promise<void>;
  /** The running Gateway's build (handshake `server`) against this app's: restart it once if not. */
  checkServerBuild(server: { build: string } | undefined): Promise<BuildCheck>;
  /** The splash's Retry after a failed update was undone (`SupervisorBase`). */
  retryAfterUpdateFailure(opts?: { restoredByHand?: boolean }): boolean;
}

/** A progress note older than this is a Gateway that died while updating, not one that is busy. */
const UPDATE_PROGRESS_FRESH_MS = 5 * 60_000;
/** Never wait longer than this for an update to finish, whatever the note says. */
const UPDATE_WAIT_CEILING_MS = 15 * 60_000;

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The dev child's command: `tsx src/main.ts` from `apps/gateway`. On Windows `.bin/tsx` is a
 * `.cmd` shim Node refuses to spawn without a shell, so the system `node` runs tsx's own CLI
 * (Electron's binary cannot: the Gateway's native addons are built for Node's ABI).
 */
export function devGatewayCommand(
  gatewayDir: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): { command: string; args: string[] } | undefined {
  const roots = [gatewayDir, join(gatewayDir, "..", "..")];
  if (platform === "win32") {
    const cli = roots
      .map((r) => join(r, "node_modules", "tsx", "dist", "cli.mjs"))
      .find((c) => exists(c));
    return cli ? { command: "node", args: [cli, "src/main.ts"] } : undefined;
  }
  // tsx is a workspace-root devDependency, so pnpm puts it in the root bin, not the Gateway's.
  const tsx = roots.map((r) => join(r, "node_modules", ".bin", "tsx")).find((c) => exists(c));
  return tsx ? { command: tsx, args: ["src/main.ts"] } : undefined;
}

/**
 * Dev, external and remote modes, the health checks, the state, the update notes and the build
 * check; a subclass adds the OS service (`startService` / `refreshService` / `uninstallService`,
 * and `ownsService` / `restartService` for a build mismatch).
 */
export abstract class SupervisorBase implements Supervisor {
  protected child: ChildProcess | undefined;
  private state: GatewayRunState = { kind: "unknown" };
  /** Builds the service was restarted for already (once each), and the restart in flight. */
  private readonly buildRestarts = new Set<string>();
  private buildRestart: Promise<BuildCheck> | undefined;
  /** This app attached to a Gateway it does not run (a terminal's, another copy's). */
  protected attached = false;
  protected readonly opts: SupervisorOptions;
  protected readonly run: Runner;

  constructor(opts: SupervisorOptions) {
    this.opts = opts;
    this.run = opts.run ?? execRunner;
  }

  /** The service mode this subclass registers. */
  protected abstract readonly serviceMode: ServiceMode;
  protected abstract startService(): Promise<void>;
  protected abstract refreshService(): Promise<void>;
  protected abstract uninstallService(): Promise<void>;
  /** The registered service runs this app's bundled Gateway (not another copy's). */
  protected abstract ownsService(): Promise<boolean>;
  /**
   * Stops the service and starts it again from the definition this build wants (so the Gateway
   * gets this build's `PSYCHE_BUILD`). False, after `failed`, when the OS would not.
   */
  protected abstract restartService(): Promise<boolean>;

  getState(): GatewayRunState {
    return this.state;
  }

  protected set(s: GatewayRunState): void {
    this.state = s;
    this.opts.onState?.(s);
  }

  protected async healthy(): Promise<boolean> {
    try {
      const res = await (this.opts.fetch ?? fetch)(this.opts.healthUrl, {
        signal: AbortSignal.timeout(1_500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** The Gateway is copying the data or migrating it (`run/update-progress.json`, still fresh). */
  private updateInProgress(): boolean {
    try {
      const note = JSON.parse(
        readFileSync(join(this.opts.psycheHome, "run", "update-progress.json"), "utf8"),
      ) as { at?: unknown };
      const at = typeof note.at === "string" ? Date.parse(note.at) : Number.NaN;
      return Number.isFinite(at) && Date.now() - at < UPDATE_PROGRESS_FRESH_MS;
    } catch {
      return false;
    }
  }

  protected async waitHealthy(): Promise<boolean> {
    const started = Date.now();
    const deadline = started + (this.opts.healthTimeoutMs ?? 60_000);
    for (;;) {
      if (await this.healthy()) return true;
      if (Date.now() >= deadline) {
        // A big database can take minutes to copy and migrate: keep waiting while the Gateway
        // says it is doing that, up to a ceiling, instead of reporting a failure under it.
        if (!this.updateInProgress() || Date.now() - started >= UPDATE_WAIT_CEILING_MS)
          return false;
      }
      await (this.opts.sleep ?? defaultSleep)(500);
    }
  }

  protected logDir(): string {
    return join(this.opts.psycheHome, "logs");
  }

  protected failed(reason: string, restoreInterrupted = false): void {
    this.set({
      kind: "stopped",
      mode: this.serviceMode,
      reason,
      logs: this.logDir(),
      ...(restoreInterrupted ? { restoreInterrupted: true } : {}),
    });
  }

  /**
   * The splash's Retry after a failed update was undone: forget the note that makes the Gateway
   * refuse the same build on the same data, so the next start tries the update again.
   */
  retryAfterUpdateFailure(opts: { restoredByHand?: boolean } = {}): boolean {
    const note = join(this.opts.psycheHome, "run", "update-failed.json");
    const had = existsSync(note);
    rmSync(note, { force: true });
    // Only for an owner who has put their data back themselves after a restore that could not
    // be finished; without it the Gateway tries to finish that restore again.
    if (opts.restoredByHand === true)
      rmSync(join(this.opts.psycheHome, "run", "restore-in-progress.json"), { force: true });
    return had;
  }

  /**
   * Why the Gateway refused to start when it undid a failed data migration (it leaves a plain
   * sentence in `run/update-failed.json`): shown in place of "did not answer". Only for the
   * build this app ships, so a note from an older build never explains a new failure.
   */
  private updateFailure(): { message: string; restoreInterrupted: boolean } | undefined {
    try {
      const note = JSON.parse(
        readFileSync(join(this.opts.psycheHome, "run", "update-failed.json"), "utf8"),
      ) as { message?: unknown; build?: unknown; key?: unknown };
      if (typeof note.message !== "string" || note.message === "") return undefined;
      if (this.opts.expectedBuild !== undefined && note.build !== this.opts.expectedBuild)
        return undefined;
      return {
        message: note.message.slice(0, 600),
        restoreInterrupted: note.key === "restore-interrupted",
      };
    } catch {
      return undefined;
    }
  }

  /** A start that never became healthy: the Gateway's own note when it left one, else `fallback`. */
  protected failedToStart(fallback: string): void {
    const known = this.updateFailure();
    this.failed(known?.message ?? fallback, known?.restoreInterrupted === true);
  }

  /**
   * The Gateway's build, from the handshake challenge's `server` (updates design §2.10), against
   * the build this app shipped. An update swaps the files under a Gateway that is still running
   * (G1); when the running one is not this app's build, restart the service once. A mismatch that
   * outlives the restart means the service runs somebody else's Gateway: say so and stop trying.
   *
   * Only for the bundled service this app registered: with another copy's Gateway attached (the
   * owner declined the takeover) or a Gateway nobody supervises, the builds differ by design.
   */
  checkServerBuild(server: { build: string } | undefined): Promise<BuildCheck> {
    const expected = this.opts.expectedBuild;
    if (this.opts.mode !== this.serviceMode || expected === undefined)
      return Promise.resolve("skipped");
    // A Gateway this app did not start, or one that is still being started: leave it be.
    if (this.attached || this.state.kind === "starting") return Promise.resolve("skipped");
    if (server?.build === expected) {
      this.buildRestarts.delete(expected);
      return Promise.resolve("match");
    }
    if (this.buildRestart) return this.buildRestart;
    const restart = (async (): Promise<BuildCheck> => {
      if (!(await this.ownsService())) return "skipped";
      if (this.buildRestarts.has(expected)) {
        // Restarted once already and it still reports another build.
        this.set({
          kind: "stopped",
          mode: this.serviceMode,
          reason: `Another copy of Psyche runs the Gateway (build ${server?.build ?? "unknown"})`,
          logs: this.logDir(),
        });
        return "mismatch";
      }
      this.buildRestarts.add(expected);
      // Stop new work and give running turns a moment to settle before the process goes.
      await this.opts.prepareRestart?.().catch(() => undefined);
      this.set({ kind: "starting", mode: this.serviceMode, step: "waiting" });
      if (!(await this.restartService())) return "mismatch";
      if (await this.waitHealthy()) {
        await this.refresh();
        return "restarted";
      }
      this.failed("The Gateway did not come back after the update");
      return "mismatch";
    })().finally(() => {
      this.buildRestart = undefined;
    });
    this.buildRestart = restart;
    return restart;
  }

  /** Makes sure a Gateway runs; returns without waiting for it to become healthy. */
  async ensureRunning(): Promise<void> {
    const { mode } = this.opts;
    if (mode === "external" || mode === "remote") {
      this.set((await this.healthy()) ? { kind: "running", mode } : { kind: "stopped", mode });
      return;
    }
    if (mode === this.serviceMode) return this.startService();
    if (mode !== "dev") {
      this.set({ kind: "stopped", mode, reason: `${mode} is not available on this computer` });
      return;
    }
    if (await this.healthy()) {
      // Something already serves the Gateway (a terminal, a service): attach, never spawn twice.
      this.set({ kind: "running", mode });
      return;
    }
    this.spawnDev();
  }

  private spawnDev(): void {
    const dir = this.opts.gatewayDir;
    if (!dir || !existsSync(join(dir, "src", "main.ts"))) {
      this.set({ kind: "stopped", mode: "dev", reason: "apps/gateway not found" });
      return;
    }
    const platform = this.opts.platform ?? process.platform;
    const cmd = devGatewayCommand(dir, platform);
    if (!cmd) {
      this.set({ kind: "stopped", mode: "dev", reason: "tsx not found (run pnpm install)" });
      return;
    }
    // The child gets PATH, HOME, PSYCHE_HOME and the developer's PSYCHE_* / provider-key variables
    // (dev mode only; a packaged build never spawns this way), not the desktop's whole environment.
    const passthrough: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (key.startsWith("PSYCHE_") || /^(ANTHROPIC|OPENAI|GOOGLE|OPENROUTER)_API_KEY$/.test(key)) {
        passthrough[key] = value;
      }
    }
    // Windows programs find their profile and temp folders through these, not HOME.
    const windowsEnv: Record<string, string> = {};
    if (platform === "win32") {
      for (const key of [
        "SystemRoot",
        "SystemDrive",
        "windir",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "PATHEXT",
        "ComSpec",
        "USERNAME",
        "USERDOMAIN",
      ]) {
        const v = process.env[key];
        if (v !== undefined) windowsEnv[key] = v;
      }
    }
    const child = spawn(cmd.command, cmd.args, {
      cwd: dir,
      env: {
        ...windowsEnv,
        ...passthrough,
        PATH: process.env.PATH ?? process.env.Path ?? "",
        HOME: homedir(),
        PSYCHE_HOME: this.opts.psycheHome,
      },
      stdio: ["ignore", "inherit", "inherit"],
      // No console window flashes up for the dev Gateway on Windows.
      windowsHide: true,
    });
    this.child = child;
    this.set({ kind: "running", mode: "dev", ...(child.pid ? { pid: child.pid } : {}) });
    // A spawn failure (ENOENT, EACCES) is an 'error', not an 'exit'; unhandled it crashes the main process.
    child.on("error", (err) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.set({ kind: "stopped", mode: "dev", reason: err.message });
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.set({ kind: "stopped", mode: "dev", reason: signal ?? `exit ${code}` });
    });
  }

  async refresh(): Promise<void> {
    const { mode } = this.opts;
    if (mode === this.serviceMode) return this.refreshService();
    if (mode === "external" || mode === "remote")
      this.set((await this.healthy()) ? { kind: "running", mode } : { kind: "stopped", mode });
  }

  async onAppQuit(): Promise<void> {
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }

  async stopEverything(): Promise<void> {
    await this.onAppQuit();
    if (this.opts.mode === this.serviceMode) await this.uninstallService();
    this.set({ kind: "stopped", mode: this.opts.mode, reason: "quit" });
  }
}
