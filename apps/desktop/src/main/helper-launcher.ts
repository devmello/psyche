import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Runner } from "./supervisor-base.ts";

/**
 * Starts the bundled host helper (docs/archive/status/s14.md "Packaging"); nothing waits on it:
 * onboarding and chat go on without it. It pairs on its own over the node socket, so this runs at
 * each desktop start once the Gateway answers, and again when the helper drops offline (throttled).
 *
 * - **macOS**: LaunchServices, never a child process, so TCC attributes its prompts and grants to
 *   PsycheHelper.app and not to Psyche.app:
 *
 *     /usr/bin/open -g -j [--env PSYCHE_HOME=<home>] <Resources>/PsycheHelper.app
 *
 *   `open` is idempotent and the helper keeps one instance per `$PSYCHE_HOME`. It has no
 *   KeepAlive and nothing else relaunches it: only this class does. When the app quits, `stopForQuit`
 *   ends it (SIGTERM to the verified pid) and latches this class so it stays down until the app is
 *   opened again.
 * - **Windows**: `<resources>\win-helper\psyche-helper.exe` spawned detached in its own process
 *   (no console, outside the app's job object), so it keeps running after Psyche quits like a
 *   LaunchServices-launched app; `PSYCHE_HOME` goes in its environment. It holds a single-instance
 *   mutex, so a second launch exits at once and this stays idempotent.
 */

/** The node kinds that are this computer's own helper (`NodeKind` in @psyche/protocol). */
export const HOST_HELPER_KINDS: readonly string[] = ["mac-helper", "win-helper", "host-helper"];

export function isHostHelperKind(kind: unknown): boolean {
  return typeof kind === "string" && HOST_HELPER_KINDS.includes(kind);
}

/**
 * Where the helper is: packaged, inside the app's resources; unpackaged on Windows, the Rust
 * build in the repo (`apps/win-helper/target/{release,debug}`). Dev macOS builds use their own
 * helper install, as before.
 */
export function helperPathFor(o: {
  platform: NodeJS.Platform;
  packaged: boolean;
  resourcesPath: string;
  /** `app.getAppPath()`: `apps/desktop` when unpackaged. */
  appPath: string;
  exists?: (path: string) => boolean;
}): string | undefined {
  const exists = o.exists ?? existsSync;
  if (o.platform === "darwin") {
    return o.packaged ? join(o.resourcesPath, "PsycheHelper.app") : undefined;
  }
  if (o.platform !== "win32") return undefined;
  if (o.packaged) return join(o.resourcesPath, "win-helper", "psyche-helper.exe");
  const target = join(o.appPath, "..", "win-helper", "target");
  return ["release", "debug"]
    .map((profile) => join(target, profile, "psyche-helper.exe"))
    .find((p) => exists(p));
}

/** The executable inside the helper: the .exe itself on Windows, the bundle's binary on macOS. */
export function helperExecutable(appPath: string): string {
  return appPath.toLowerCase().endsWith(".exe")
    ? appPath
    : join(appPath, "Contents", "MacOS", "psyche-helper");
}

/** Starts a program in its own detached process; resolves once it started or failed to. */
export type DetachedLauncher = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ ok: true } | { ok: false; error: string }>;

export const spawnDetached: DetachedLauncher = (file, args, env) =>
  new Promise((resolve) => {
    try {
      const child = spawn(file, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env,
      });
      child.once("error", (err) => resolve({ ok: false, error: err.message }));
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

/**
 * Authenticode status of a Windows executable (`Get-AuthenticodeSignature`): `Valid`,
 * `NotSigned`, or why a signature is bad (`HashMismatch`, `NotTrusted`, …). Undefined when it
 * could not be read.
 */
export async function authenticodeStatus(
  exe: string,
  run: Runner,
  systemRoot = process.env.SystemRoot ?? "C:\\Windows",
): Promise<string | undefined> {
  const lit = `'${exe.replaceAll("'", "''")}'`;
  const res = await run(`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `[string](Get-AuthenticodeSignature -LiteralPath ${lit}).Status`,
  ]);
  const status = res.stdout.trim();
  return res.code === 0 && /^[A-Za-z]+$/.test(status) ? status : undefined;
}

/** An unsigned dev build is fine; a signature that does not verify is a tampered helper. */
export function authenticodeAcceptable(status: string | undefined): boolean {
  return status === undefined || status === "Valid" || status === "NotSigned";
}

export type HelperRunState =
  /** Dev builds and other platforms: nothing to launch. */
  | { kind: "unbundled" }
  | { kind: "starting" }
  | { kind: "paired" }
  /** Launched (or was paired) but not connected now. */
  | { kind: "offline"; reason?: string };

export interface HelperLauncherOptions {
  /** `helperPathFor(...)`: the helper bundle or .exe, or undefined when there is none. */
  appPath: string | undefined;
  psycheHome: string;
  run: Runner;
  /** True when `nodes.list` shows this computer's helper (`mac-helper`, `win-helper`) online. */
  isPaired: () => Promise<boolean>;
  /** Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Windows: starts the .exe detached (default `spawnDetached`). */
  launchDetached?: DetachedLauncher;
  /**
   * Windows, packaged: checks the helper's Authenticode signature before the first launch. It runs
   * in the background from construction and a launch waits for it at most `signatureWaitMs`.
   */
  verifySignature?: boolean;
  signatureWaitMs?: number;
  onState?: (s: HelperRunState) => void;
  /** True while the app's own signature fails (bundle-integrity.ts): the helper is not started. */
  blocked?: () => boolean;
  /** How long a launch may take to pair before it counts as offline (default 30 s). */
  pairTimeoutMs?: number;
  /** Least time between two relaunches after it went offline (default 60 s). */
  relaunchEveryMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The pid in the helper's lock file (`<home>/run/helper.lock`); tests pass their own. */
  readPid?: () => number | undefined;
  kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** `stopForQuit`: runs a program to completion, since a quit cannot wait on a promise. */
  runSync?: (file: string, args: string[]) => { code: number; stdout: string };
  /** `stopForQuit`: whether a pid is still a live process (default `kill(pid, 0)`). */
  isAlive?: (pid: number) => boolean;
  /** `stopForQuit`: blocks for `ms` (default `Atomics.wait`). */
  sleepSync?: (ms: number) => void;
}

/** What `HelperLauncher.stopForQuit` found. */
export type HelperStopResult =
  /** Not a macOS bundled helper, or nothing to stop on this Gateway. */
  | "not-applicable"
  /** No live process of the bundled helper held the lock. */
  | "not-running"
  /** SIGTERM was sent and the process exited. */
  | "stopped"
  /** It was still there after the grace period, so it was killed. */
  | "killed"
  /** It was still there after SIGKILL too. */
  | "still-running";

const defaultRunSync: NonNullable<HelperLauncherOptions["runSync"]> = (file, args) => {
  const res = spawnSync(file, args, { encoding: "utf8", timeout: 2_000 });
  return { code: res.status ?? 1, stdout: res.stdout ?? "" };
};

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but is not ours.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

const defaultSleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function lockPid(psycheHome: string): number | undefined {
  try {
    const n = Number.parseInt(
      readFileSync(join(psycheHome, "run", "helper.lock"), "utf8").trim(),
      10,
    );
    return Number.isInteger(n) && n > 1 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function openHelperArgs(appPath: string, psycheHome: string, home = homedir()): string[] {
  const env = psycheHome === join(home, ".psyche") ? [] : ["--env", `PSYCHE_HOME=${psycheHome}`];
  return ["-g", "-j", ...env, appPath];
}

export class HelperLauncher {
  private state: HelperRunState;
  private lastLaunch = Number.NEGATIVE_INFINITY;
  private launching: Promise<void> | undefined;
  private readonly opts: HelperLauncherOptions;
  /** Windows: whether the signature check passed (true until it says otherwise). */
  private signature: Promise<boolean> | undefined;
  private signatureBad = false;
  /** Set by `stopForQuit`: from then on nothing starts the helper (the app is going away). */
  private stopped = false;

  constructor(opts: HelperLauncherOptions) {
    this.opts = opts;
    this.state =
      opts.appPath && existsSync(opts.appPath) ? { kind: "offline" } : { kind: "unbundled" };
    if (this.windows && opts.verifySignature === true && this.state.kind !== "unbundled") {
      this.signature = authenticodeStatus(opts.appPath as string, opts.run)
        .then((status) => authenticodeAcceptable(status))
        .catch(() => true)
        .then((ok) => {
          this.signatureBad = !ok;
          return ok;
        });
    }
  }

  private get windows(): boolean {
    return (this.opts.platform ?? process.platform) === "win32";
  }

  /** Waits for the signature check, never longer than `signatureWaitMs` (default 3 s). */
  private async signatureOk(): Promise<boolean> {
    if (this.signature === undefined) return true;
    const timeout = new Promise<boolean>((r) => {
      const t = setTimeout(() => r(true), this.opts.signatureWaitMs ?? 3_000);
      t.unref?.();
    });
    return Promise.race([this.signature, timeout]);
  }

  /** Starts the helper the platform's way; an error message when it could not. */
  private async start(appPath: string): Promise<string | undefined> {
    if (this.windows) {
      const res = await (this.opts.launchDetached ?? spawnDetached)(appPath, [], {
        ...process.env,
        PSYCHE_HOME: this.opts.psycheHome,
      });
      return res.ok ? undefined : res.error;
    }
    const res = await this.opts.run("/usr/bin/open", openHelperArgs(appPath, this.opts.psycheHome));
    return res.code === 0 ? undefined : res.stderr.trim() || `open exited ${res.code}`;
  }

  getState(): HelperRunState {
    return this.state;
  }

  private set(s: HelperRunState): void {
    if (s.kind === this.state.kind && JSON.stringify(s) === JSON.stringify(this.state)) return;
    this.state = s;
    this.opts.onState?.(s);
  }

  /**
   * Windows ("Start Psyche Helper" on a running one): ends the running helper (its
   * single-instance mutex goes with the process) and starts it again, then waits for it to
   * pair. Elsewhere the same as `launch`.
   */
  async restart(): Promise<void> {
    if (this.state.kind === "unbundled" || this.stopped) return;
    if (!this.windows) return this.restartMac();
    await this.launching?.catch(() => undefined);
    const appPath = this.opts.appPath as string;
    const lit = `'${appPath.replaceAll("'", "''")}'`;
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    await this.opts.run(`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p=${lit};Get-CimInstance Win32_Process -Filter "Name='psyche-helper.exe'" | Where-Object { $_.ExecutablePath -eq $p } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ]);
    this.set({ kind: "offline", reason: "restarting" });
    this.launching = this.doLaunch(true).finally(() => {
      this.launching = undefined;
    });
    return this.launching;
  }

  /** Launches the helper unless it is already paired; resolves once it paired or timed out. */
  launch(): Promise<void> {
    if (this.state.kind === "unbundled" || this.stopped) return Promise.resolve();
    if (this.opts.blocked?.()) {
      this.set({ kind: "offline", reason: "this copy of Psyche was modified" });
      return Promise.resolve();
    }
    this.launching ??= this.doLaunch().finally(() => {
      this.launching = undefined;
    });
    return this.launching;
  }

  /**
   * Quits the running helper (SIGTERM to the pid in its lock file, and only when `ps` says that pid
   * is a psyche-helper) and starts it again: a card's "Restart Psyche Helper" after its Touch ID key
   * changed while it ran.
   */
  private async restartMac(): Promise<void> {
    const pid = this.opts.readPid ? this.opts.readPid() : lockPid(this.opts.psycheHome);
    if (pid !== undefined) {
      const ps = await this.opts
        .run("/bin/ps", ["-p", String(pid), "-o", "comm="])
        .catch(() => undefined);
      if (ps?.code === 0 && ps.stdout.includes("psyche-helper")) {
        try {
          (this.opts.kill ?? process.kill)(pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const end = now() + 10_000;
    while (now() < end && (await this.opts.isPaired().catch(() => false))) await sleep(250);
    this.set({ kind: "offline" });
    await this.launch();
  }

  /**
   * The app is quitting (⌘Q, the menu bar or Dock, "Quit Psyche entirely", an update or restart
   * relaunch): ends the helper this app started, so no PsycheHelper outlives it. Closing the
   * window while the app lives on in the menu bar never comes here. A relaunched app starts the
   * helper again the way any start does (`launch`, once the Gateway answers).
   *
   * Synchronous, because Electron's `before-quit` cannot wait. The pid comes from the helper's lock
   * file, which keeps its last pid after the helper exits, so it is signalled only when `ps` names
   * that pid's executable as exactly the bundled helper's: a reused pid is some other program and is
   * left alone. SIGTERM first (the helper releases its locks and leaves its node session), SIGKILL
   * only after `graceMs` (default 1.5 s) if the same verified process is still there. Latches the
   * launcher first, so a `node.updated` that the helper's exit causes cannot start it again.
   * macOS only: the Windows helper is meant to outlive the app (see the top of this file).
   */
  stopForQuit(graceMs = 1_500): HelperStopResult {
    this.stopped = true;
    const appPath = this.opts.appPath;
    if (
      this.state.kind === "unbundled" ||
      appPath === undefined ||
      (this.opts.platform ?? process.platform) !== "darwin"
    ) {
      return "not-applicable";
    }
    const pid = this.opts.readPid ? this.opts.readPid() : lockPid(this.opts.psycheHome);
    if (pid === undefined) return "not-running";
    const exe = helperExecutable(appPath);
    const runSync = this.opts.runSync ?? defaultRunSync;
    const isAlive = this.opts.isAlive ?? defaultIsAlive;
    const kill = this.opts.kill ?? process.kill;
    // The executable path is checked again before each signal: the pid must still be the helper's.
    const isOurHelper = (): boolean => {
      try {
        const ps = runSync("/bin/ps", ["-p", String(pid), "-o", "comm="]);
        return ps.code === 0 && ps.stdout.trim() === exe;
      } catch {
        return false;
      }
    };
    if (!isOurHelper()) return "not-running";
    try {
      kill(pid, "SIGTERM");
    } catch {
      return "not-running";
    }
    const sleep = this.opts.sleepSync ?? defaultSleepSync;
    const waitGone = (ms: number): boolean => {
      for (let waited = 0; isAlive(pid); waited += 50) {
        if (waited >= ms) return false;
        sleep(50);
      }
      return true;
    };
    if (waitGone(graceMs)) return "stopped";
    if (!isOurHelper()) return "stopped";
    try {
      kill(pid, "SIGKILL");
    } catch {
      return "stopped";
    }
    return waitGone(500) ? "killed" : "still-running";
  }

  /** `fresh`: a restart, where the old helper's pairing must not count. */
  private async doLaunch(fresh = false): Promise<void> {
    const appPath = this.opts.appPath as string;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    if (fresh) {
      // The Gateway sees the old one go within a moment of its exit.
      for (let i = 0; i < 10 && (await this.opts.isPaired().catch(() => false)); i++) {
        await sleep(500);
      }
    } else if (await this.opts.isPaired().catch(() => false)) return this.set({ kind: "paired" });
    if (!(await this.signatureOk()) || this.signatureBad) {
      return this.set({ kind: "offline", reason: "the helper's signature is not valid" });
    }
    if (this.stopped) return;
    this.lastLaunch = (this.opts.now ?? Date.now)();
    this.set({ kind: "starting" });
    const error = await this.start(appPath);
    if (error !== undefined) return this.set({ kind: "offline", reason: error });
    const deadline = (this.opts.now ?? Date.now)() + (this.opts.pairTimeoutMs ?? 30_000);
    for (;;) {
      if (this.stopped) return;
      if (await this.opts.isPaired().catch(() => false)) return this.set({ kind: "paired" });
      if ((this.opts.now ?? Date.now)() >= deadline) break;
      await sleep(1_000);
    }
    this.set({ kind: "offline", reason: "it did not connect to the Gateway" });
  }

  /**
   * After `node.updated` or a reconnect: record the helper's presence, and relaunch it when it is
   * gone (it quit, crashed or was replaced by an update), at most once per `relaunchEveryMs`.
   */
  async onPresence(paired: boolean): Promise<void> {
    if (this.state.kind === "unbundled" || this.stopped || this.opts.blocked?.()) return;
    if (paired) return this.set({ kind: "paired" });
    if (this.launching) return;
    const now = (this.opts.now ?? Date.now)();
    if (now - this.lastLaunch < (this.opts.relaunchEveryMs ?? 60_000)) {
      if (this.state.kind === "paired") this.set({ kind: "offline" });
      return;
    }
    await this.launch();
  }
}

/**
 * Whether the bundled helper can hold the vault's Keychain (Touch ID) slot: signed with a team
 * (Developer ID) and carrying a provisioning profile, which grants the keychain access group. An
 * ad-hoc or profile-less helper answers keychain.* with missing_entitlement, so the packaged
 * desktop gives the vault a key file instead (approved design, docs/05 "Key storage on unsigned
 * builds").
 */
export async function helperCanHoldKeychain(
  appPath: string | undefined,
  run: Runner,
): Promise<boolean> {
  if (appPath === undefined || !existsSync(appPath)) return false;
  // The Keychain slot is macOS's; a Windows helper has none (the vault uses the key file there).
  if (appPath.toLowerCase().endsWith(".exe")) return false;
  if (!existsSync(join(appPath, "Contents", "embedded.provisionprofile"))) return false;
  const res = await run("/usr/bin/codesign", ["-dv", appPath]);
  const info = `${res.stdout}\n${res.stderr}`;
  if (res.code !== 0 || /Signature=adhoc/.test(info)) return false;
  const team = /^TeamIdentifier=(.+)$/m.exec(info)?.[1]?.trim();
  return team !== undefined && team !== "not set";
}

/**
 * Asks for the helper's notification permission once it pairs, when nobody has yet. Until then
 * macOS refuses every `notify.show` with `permission_not_determined`, so approval cards (and
 * their Touch ID answers) never reach the Mac and nothing says why. Answered or denied before:
 * nothing happens (the owner changes it in System Settings). True when it asked.
 */
export async function askHelperNotificationsIfUndetermined(
  invoke: (capability: string, params: unknown) => Promise<unknown>,
): Promise<boolean> {
  const status = (await invoke("notify.authorization_status", {})) as { status?: unknown } | null;
  if (status?.status !== "notDetermined") return false;
  await invoke("notify.request_authorization", { provisional: false });
  return true;
}

/**
 * Whether the keyboard layout in use has AltGr, as the bundled Windows helper measures it
 * (`psyche-helper --keyboard-layout` prints `{layout, altGr}`); undefined when not bundled or
 * the output is not what a helper prints.
 */
export async function readAltGrLayout(
  appPath: string | undefined,
  run: IdentityRunner,
): Promise<boolean | undefined> {
  if (appPath === undefined || !existsSync(appPath)) return undefined;
  const res = await run(helperExecutable(appPath), ["--keyboard-layout"], process.env);
  if (res.code !== 0) return undefined;
  try {
    const out = JSON.parse(res.stdout.trim()) as { altGr?: unknown };
    return typeof out.altGr === "boolean" ? out.altGr : undefined;
  } catch {
    return undefined;
  }
}

/** What the bundled helper says about itself (`psyche-helper --print-identity`). */
export interface HelperIdentity {
  deviceId: string;
  /** Hex SHA-256 of its Touch ID public key, when it has one. */
  keyId?: string;
  kind?: "keychain" | "enclave_keychain_acl" | "enclave_file";
  /** Why it has no key (`missing_entitlement`, `presence_key_file`, …). */
  error?: string;
}

export type IdentityRunner = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ code: number; stdout: string }>;

/**
 * The device id and Touch ID key id of the helper inside this app (security §10): main runs the
 * bundled executable itself, at a fixed path inside its own signed bundle, so the answer does not
 * come from whatever node paired on the Gateway's socket. Registration then requires this key id
 * (`expectKeyId`) and window approvals name this device (`helperDeviceId`). Undefined when not
 * bundled or the output is not what a helper prints.
 */
export async function readHelperIdentity(
  appPath: string | undefined,
  psycheHome: string,
  run: IdentityRunner,
): Promise<HelperIdentity | undefined> {
  if (appPath === undefined || !existsSync(appPath)) return undefined;
  const exe = helperExecutable(appPath);
  const res = await run(exe, ["--print-identity"], { ...process.env, PSYCHE_HOME: psycheHome });
  if (res.code !== 0) return undefined;
  let out: Record<string, unknown>;
  try {
    out = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof out.deviceId !== "string" || !/^dev_[A-Za-z0-9_-]{22}$/.test(out.deviceId)) {
    return undefined;
  }
  const keyId =
    typeof out.presenceKeyId === "string" && /^[0-9a-f]{64}$/.test(out.presenceKeyId)
      ? out.presenceKeyId
      : undefined;
  const kind =
    out.presenceKeyKind === "keychain" ||
    out.presenceKeyKind === "enclave_keychain_acl" ||
    out.presenceKeyKind === "enclave_file"
      ? out.presenceKeyKind
      : undefined;
  const error =
    typeof out.presenceError === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(out.presenceError)
      ? out.presenceError
      : undefined;
  return {
    deviceId: out.deviceId,
    ...(keyId === undefined ? {} : { keyId }),
    ...(kind === undefined ? {} : { kind }),
    ...(error === undefined ? {} : { error }),
  };
}
