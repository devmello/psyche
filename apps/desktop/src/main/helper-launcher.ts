import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Runner } from "./supervisor.ts";

/**
 * Starts the bundled Mac helper (docs/status/s14.md "Packaging"): LaunchServices, never a child
 * process, so TCC attributes its prompts and grants to PsycheHelper.app and not to Psyche.app:
 *
 *   /usr/bin/open -g -j [--env PSYCHE_HOME=<home>] <Resources>/PsycheHelper.app
 *
 * `open` is idempotent and the helper keeps one instance per `$PSYCHE_HOME`, so this runs at each
 * desktop start once the Gateway answers, and again when the helper drops offline (throttled). It
 * pairs on its own over the node socket. Nothing waits on it: onboarding and chat go on without it.
 */

export type HelperRunState =
  /** Dev builds and other platforms: nothing to launch. */
  | { kind: "unbundled" }
  | { kind: "starting" }
  | { kind: "paired" }
  /** Launched (or was paired) but not connected now. */
  | { kind: "offline"; reason?: string };

export interface HelperLauncherOptions {
  /** `<process.resourcesPath>/PsycheHelper.app`, or undefined when not packaged on macOS. */
  appPath: string | undefined;
  psycheHome: string;
  run: Runner;
  /** True when `nodes.list` shows a `mac-helper` node online. */
  isPaired: () => Promise<boolean>;
  onState?: (s: HelperRunState) => void;
  /** How long a launch may take to pair before it counts as offline (default 30 s). */
  pairTimeoutMs?: number;
  /** Least time between two relaunches after it went offline (default 60 s). */
  relaunchEveryMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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

  constructor(opts: HelperLauncherOptions) {
    this.opts = opts;
    this.state =
      opts.appPath && existsSync(opts.appPath) ? { kind: "offline" } : { kind: "unbundled" };
  }

  getState(): HelperRunState {
    return this.state;
  }

  private set(s: HelperRunState): void {
    if (s.kind === this.state.kind && JSON.stringify(s) === JSON.stringify(this.state)) return;
    this.state = s;
    this.opts.onState?.(s);
  }

  /** Launches the helper unless it is already paired; resolves once it paired or timed out. */
  launch(): Promise<void> {
    if (this.state.kind === "unbundled") return Promise.resolve();
    this.launching ??= this.doLaunch().finally(() => {
      this.launching = undefined;
    });
    return this.launching;
  }

  private async doLaunch(): Promise<void> {
    const appPath = this.opts.appPath as string;
    if (await this.opts.isPaired().catch(() => false)) return this.set({ kind: "paired" });
    this.lastLaunch = (this.opts.now ?? Date.now)();
    this.set({ kind: "starting" });
    const res = await this.opts.run("/usr/bin/open", openHelperArgs(appPath, this.opts.psycheHome));
    if (res.code !== 0) {
      return this.set({ kind: "offline", reason: res.stderr.trim() || `open exited ${res.code}` });
    }
    const deadline = (this.opts.now ?? Date.now)() + (this.opts.pairTimeoutMs ?? 30_000);
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (;;) {
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
    if (this.state.kind === "unbundled") return;
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
  if (!existsSync(join(appPath, "Contents", "embedded.provisionprofile"))) return false;
  const res = await run("/usr/bin/codesign", ["-dv", appPath]);
  const info = `${res.stdout}\n${res.stderr}`;
  if (res.code !== 0 || /Signature=adhoc/.test(info)) return false;
  const team = /^TeamIdentifier=(.+)$/m.exec(info)?.[1]?.trim();
  return team !== undefined && team !== "not set";
}
