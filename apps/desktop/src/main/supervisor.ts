import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import {
  defaultSleep,
  type Supervisor,
  SupervisorBase,
  type SupervisorOptions,
} from "./supervisor-base.ts";
import { type TaskSchedulerOptions, TaskSchedulerSupervisor } from "./supervisor-windows.ts";

export {
  chooseMode,
  desktopVaultKeyFile,
  devGatewayCommand,
  execRunner,
  type GatewayRunState,
  type Runner,
  type Supervisor,
  type SupervisorMode,
  type SupervisorOptions,
  serviceModeFor,
} from "./supervisor-base.ts";
export { TaskSchedulerSupervisor } from "./supervisor-windows.ts";

/**
 * The macOS Gateway service (feature A7): packaged builds install (or update) the LaunchAgent
 * `com.psyche.gateway` for the bundled `Resources/psyched/psyched`, start it and wait for
 * `/healthz`. The plist is S22's template (`Resources/launchd/com.psyche.gateway.plist`,
 * `{{PSYCHED}}` and `{{PSYCHE_HOME}}` rendered here); without it `renderLaunchAgentPlist` writes
 * the same keys. Plain quit leaves the agent running; "Quit Psyche entirely" uninstalls it. The
 * dev, external and remote modes are `SupervisorBase`'s; Windows is `supervisor-windows.ts`.
 */

export const LAUNCH_AGENT_LABEL = "com.psyche.gateway";

function xml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export interface PlistInput {
  program: string;
  args?: string[];
  psycheHome: string;
  logDir: string;
}

/** Fills S22's plist template: `{{PSYCHED}}` and `{{PSYCHE_HOME}}`, XML-escaped. */
export function renderPlistTemplate(
  template: string,
  values: { program: string; psycheHome: string },
): string {
  return template
    .replaceAll("{{PSYCHED}}", xml(values.program))
    .replaceAll("{{PSYCHE_HOME}}", xml(values.psycheHome));
}

/** Adds variables to the plist's `EnvironmentVariables` dict (values XML-escaped). */
export function withPlistEnv(plist: string, env: Record<string, string>): string {
  const entries = Object.entries(env);
  if (entries.length === 0) return plist;
  const lines = entries
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  const anchor = /(<key>EnvironmentVariables<\/key>\s*<dict>)/;
  if (!anchor.test(plist))
    throw new Error("the LaunchAgent plist has no EnvironmentVariables dict");
  return plist.replace(anchor, (m) => `${m}\n${lines}`);
}

/** The program a LaunchAgent plist runs: the first `ProgramArguments` string, XML-unescaped. */
export function plistProgram(plist: string): string | undefined {
  const raw = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
  return raw
    ?.replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * macOS runs an app opened straight from a DMG or a quarantined download from a random read-only
 * path (App Translocation) that disappears on quit: a LaunchAgent must never point there.
 */
export function isTranslocated(path: string): boolean {
  return path.includes("/AppTranslocation/");
}

/**
 * launchd's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`; Homebrew comes first so the CLIs the
 * Gateway runs (Claude Code, Codex) are found (#530). Same line as `apps/cli`'s plist.
 */
export const LAUNCH_AGENT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** LaunchAgent plist: KeepAlive, RunAtLoad, logs under `$PSYCHE_HOME/logs`, no secrets. */
export function renderLaunchAgentPlist(input: PlistInput): string {
  const argv = [input.program, ...(input.args ?? [])]
    .map((a) => `    <string>${xml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PSYCHE_HOME</key>
    <string>${xml(input.psycheHome)}</string>
    <key>PATH</key>
    <string>${LAUNCH_AGENT_PATH}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(posix.join(input.logDir, "gateway.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(posix.join(input.logDir, "gateway.err.log"))}</string>
</dict>
</plist>
`;
}

export function launchAgentPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

/** `launchctl` argv for the per-user GUI domain (macOS 10.10+ subcommands). */
export const launchctl = {
  print: (uid: number) => ["print", `gui/${uid}/${LAUNCH_AGENT_LABEL}`],
  bootstrap: (uid: number, plist: string) => ["bootstrap", `gui/${uid}`, plist],
  kickstart: (uid: number) => ["kickstart", `gui/${uid}/${LAUNCH_AGENT_LABEL}`],
  bootout: (uid: number) => ["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`],
} as const;

/** Reads `state`, `pid` and `last exit code` from `launchctl print` output. */
export function parseLaunchctlPrint(out: string): {
  running: boolean;
  pid?: number;
  lastExit?: string;
} {
  const state = /^\s*state = (\S+)/m.exec(out)?.[1];
  const pid = /^\s*pid = (\d+)/m.exec(out)?.[1];
  const lastExit = /^\s*last exit code = (.+)$/m.exec(out)?.[1]?.trim();
  return {
    running: state === "running",
    ...(pid ? { pid: Number(pid) } : {}),
    ...(lastExit ? { lastExit } : {}),
  };
}

export interface LaunchdOptions extends SupervisorOptions {
  /** launchd: the bundled `psyched` executable and plist (when the release ships them). */
  bundledProgram?: string;
  bundledPlist?: string;
  uid?: number;
  /** Defaults to `~/Library/LaunchAgents` (tests pass a tmp dir). */
  launchAgentsDir?: string;
}

export class LaunchdSupervisor extends SupervisorBase {
  protected readonly serviceMode = "launchd" as const;
  private readonly launchd: LaunchdOptions;

  constructor(opts: LaunchdOptions) {
    super(opts);
    this.launchd = opts;
  }

  private uid(): number {
    return this.launchd.uid ?? process.getuid?.() ?? 501;
  }

  private plistPath(): string {
    return this.launchd.launchAgentsDir
      ? join(this.launchd.launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`)
      : launchAgentPath();
  }

  /** The plist this build wants installed, or undefined when no Gateway is bundled. */
  private async launchAgentContent(): Promise<string | undefined> {
    const program = this.launchd.bundledProgram;
    if (!program || !existsSync(program)) return undefined;
    const values = { program, psycheHome: this.opts.psycheHome };
    const plist =
      this.launchd.bundledPlist && existsSync(this.launchd.bundledPlist)
        ? renderPlistTemplate(readFileSync(this.launchd.bundledPlist, "utf8"), values)
        : renderLaunchAgentPlist({ ...values, logDir: this.logDir() });
    const keyFile = await this.opts.vaultKeyFile?.();
    return keyFile === undefined ? plist : withPlistEnv(plist, { PSYCHE_VAULT_KEY_FILE: keyFile });
  }

  private async bootstrap(uid: number, plistPath: string): Promise<boolean> {
    // A bootout just before is asynchronous: bootstrap fails (EIO) until the old job is gone.
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await this.run("/bin/launchctl", [...launchctl.bootstrap(uid, plistPath)]);
      if (res.code === 0) return true;
      if ((await this.run("/bin/launchctl", [...launchctl.print(uid)])).code === 0) return true;
      await (this.opts.sleep ?? defaultSleep)(500);
    }
    return false;
  }

  protected startService(): Promise<void> {
    return this.startLaunchAgent();
  }

  /**
   * Installs or updates the LaunchAgent for the bundled psyched (a moved or updated app changes
   * the plist), starts it and waits for `/healthz`. A Gateway that already answers while our agent
   * is not loaded (a terminal, another install) is attached to, never doubled.
   */
  async startLaunchAgent(): Promise<void> {
    const uid = this.uid();
    const program = this.launchd.bundledProgram ?? "";
    if (isTranslocated(program)) {
      this.set({
        kind: "stopped",
        mode: "launchd",
        reason: "Move Psyche to the Applications folder and open it again",
      });
      return;
    }
    const content = await this.launchAgentContent();
    if (content === undefined) {
      this.set({ kind: "stopped", mode: "launchd", reason: "psyched is not bundled" });
      return;
    }
    const plistPath = this.plistPath();
    const loaded = (await this.run("/bin/launchctl", [...launchctl.print(uid)])).code === 0;
    const current = existsSync(plistPath) ? readFileSync(plistPath, "utf8") : undefined;
    const changed = current !== content;
    const other = current === undefined ? undefined : plistProgram(current);
    if (other !== undefined && other !== program && existsSync(other)) {
      const takeOver = (await this.opts.confirmTakeover?.(other).catch(() => false)) ?? false;
      if (!takeOver) {
        this.set(
          (await this.healthy())
            ? { kind: "running", mode: "launchd" }
            : {
                kind: "stopped",
                mode: "launchd",
                reason: `Another copy of Psyche runs the Gateway (${other})`,
                logs: this.logDir(),
              },
        );
        return;
      }
    }
    if (!loaded && (await this.healthy())) {
      // Someone else serves the Gateway on this port; starting ours would crash-loop on bind.
      this.set({ kind: "running", mode: "launchd" });
      return;
    }
    if (changed) {
      this.set({ kind: "starting", mode: "launchd", step: "installing" });
      if (loaded) await this.run("/bin/launchctl", [...launchctl.bootout(uid)]);
      mkdirSync(dirname(plistPath), { recursive: true });
      writeFileSync(plistPath, content, { mode: 0o644 });
      // launchd refuses quarantined programs; the owner already opened this signed bundle.
      await this.run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", dirname(program)]);
    }
    mkdirSync(this.opts.psycheHome, { recursive: true, mode: 0o700 });
    mkdirSync(this.logDir(), { recursive: true, mode: 0o700 });
    if ((changed || !loaded) && !(await this.bootstrap(uid, plistPath))) {
      return this.failed("launchctl could not load com.psyche.gateway");
    }
    if (loaded && !changed && (await this.healthy())) return this.refresh();
    this.set({ kind: "starting", mode: "launchd", step: "waiting" });
    await this.run("/bin/launchctl", [...launchctl.kickstart(uid)]);
    if (await this.waitHealthy()) return this.refresh();
    const printed = await this.run("/bin/launchctl", [...launchctl.print(uid)]);
    const exit = parseLaunchctlPrint(printed.stdout).lastExit;
    const secs = Math.round((this.opts.healthTimeoutMs ?? 60_000) / 1000);
    this.failed(
      `The Gateway did not answer within ${secs} s${exit && exit !== "0" ? ` (last exit code ${exit})` : ""}`,
    );
  }

  protected async refreshService(): Promise<void> {
    const printed = await this.run("/bin/launchctl", [...launchctl.print(this.uid())]);
    if (printed.code !== 0)
      return this.set({ kind: "stopped", mode: "launchd", reason: "not loaded" });
    const p = parseLaunchctlPrint(printed.stdout);
    this.set(
      p.running
        ? { kind: "running", mode: "launchd", ...(p.pid ? { pid: p.pid } : {}) }
        : { kind: "stopped", mode: "launchd" },
    );
  }

  protected uninstallService(): Promise<void> {
    return this.uninstallLaunchAgent();
  }

  /**
   * Boots the agent out and removes its plist; the next launch installs it again. An agent that
   * runs another copy's psyched is left alone: quitting this copy must not break that install.
   */
  async uninstallLaunchAgent(): Promise<void> {
    const plistPath = this.plistPath();
    const current = existsSync(plistPath) ? readFileSync(plistPath, "utf8") : undefined;
    const program = current === undefined ? undefined : plistProgram(current);
    if (program !== undefined && program !== this.launchd.bundledProgram) return;
    await this.run("/bin/launchctl", [...launchctl.bootout(this.uid())]);
    rmSync(plistPath, { force: true });
  }
}

/** Everything either OS service takes; each reads its own part. */
export type AnySupervisorOptions = LaunchdOptions & Partial<TaskSchedulerOptions>;

/** The supervisor for this OS: Task Scheduler on Windows, launchd on macOS. */
export function createSupervisor(
  opts: AnySupervisorOptions,
  platform: NodeJS.Platform = process.platform,
): Supervisor {
  if (platform === "win32") return new TaskSchedulerSupervisor(opts as TaskSchedulerOptions);
  return new LaunchdSupervisor(opts);
}
