import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Gateway lifecycle (feature A7, architecture §3.1). The window is only a client: work continues
 * when it closes because the Gateway runs on its own.
 *
 * - `dev`: unpackaged builds spawn `psyched` from `apps/gateway` as a child (stopped on quit),
 *   unless a Gateway already answers `/healthz`.
 * - `launchd`: packaged builds install (or update) the LaunchAgent `com.psyche.gateway` for the
 *   bundled `Resources/psyched/psyched`, start it and wait for `/healthz`. The plist is S22's
 *   template (`Resources/launchd/com.psyche.gateway.plist`, `{{PSYCHED}}` and `{{PSYCHE_HOME}}`
 *   rendered here); without it `renderLaunchAgentPlist` writes the same keys. Plain quit leaves
 *   the agent running; "Quit Psyche entirely" uninstalls it.
 * - `external`: never start anything (tests, a Gateway on another machine via SSH tunnel).
 */

export type SupervisorMode = "dev" | "launchd" | "external";

export const LAUNCH_AGENT_LABEL = "com.psyche.gateway";

export type GatewayRunState =
  | { kind: "unknown" }
  | { kind: "starting"; mode: SupervisorMode }
  | { kind: "running"; mode: SupervisorMode; pid?: number }
  /** `logs`: the folder with gateway.{out,err}.log when the failure is worth reading them for. */
  | { kind: "stopped"; mode: SupervisorMode; reason?: string; logs?: string };

export function chooseMode(env: NodeJS.ProcessEnv, isPackaged: boolean): SupervisorMode {
  const forced = env.PSYCHE_GATEWAY_MODE;
  if (forced === "dev" || forced === "launchd" || forced === "external") return forced;
  return isPackaged ? "launchd" : "dev";
}

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

/**
 * The packaged desktop's vault key slot: a 0600 random key file under `$PSYCHE_HOME/secrets/`,
 * like server mode, because an ad-hoc helper has no keychain access group (keychain.* answers
 * missing_entitlement). Created on first use; never when the vault already exists with another
 * slot (switching would lock the owner out).
 */
export function desktopVaultKeyFile(psycheHome: string): string | undefined {
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
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
  }
  return keyFile;
}

/**
 * macOS runs an app opened straight from a DMG or a quarantined download from a random read-only
 * path (App Translocation) that disappears on quit: a LaunchAgent must never point there.
 */
export function isTranslocated(path: string): boolean {
  return path.includes("/AppTranslocation/");
}

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
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(join(input.logDir, "gateway.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(input.logDir, "gateway.err.log"))}</string>
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

export type Runner = (
  file: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const execRunner: Runner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000 }, (err, stdout, stderr) => {
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
  /** launchd: the bundled `psyched` executable and plist (when the release ships them). */
  bundledProgram?: string;
  bundledPlist?: string;
  uid?: number;
  /** Defaults to `~/Library/LaunchAgents` (tests pass a tmp dir). */
  launchAgentsDir?: string;
  /** launchd: pass `PSYCHE_VAULT_KEY_FILE` to the Gateway (`desktopVaultKeyFile`). */
  vaultKeyFile?: () => string | undefined;
  /** launchd: how long to wait for `/healthz` after starting the agent (default 60 s). */
  healthTimeoutMs?: number;
  run?: Runner;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onState?: (s: GatewayRunState) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GatewaySupervisor {
  private child: ChildProcess | undefined;
  private state: GatewayRunState = { kind: "unknown" };
  private readonly opts: SupervisorOptions;
  private readonly run: Runner;

  constructor(opts: SupervisorOptions) {
    this.opts = opts;
    this.run = opts.run ?? execRunner;
  }

  getState(): GatewayRunState {
    return this.state;
  }

  private set(s: GatewayRunState): void {
    this.state = s;
    this.opts.onState?.(s);
  }

  private async healthy(): Promise<boolean> {
    try {
      const res = await (this.opts.fetch ?? fetch)(this.opts.healthUrl, {
        signal: AbortSignal.timeout(1_500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Makes sure a Gateway runs; returns without waiting for it to become healthy. */
  async ensureRunning(): Promise<void> {
    const { mode } = this.opts;
    if (mode === "external") {
      this.set((await this.healthy()) ? { kind: "running", mode } : { kind: "stopped", mode });
      return;
    }
    if (mode === "launchd") return this.startLaunchAgent();
    if (await this.healthy()) {
      // Something already serves the Gateway (a terminal, a LaunchAgent): attach, never spawn twice.
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
    // tsx is a workspace-root devDependency, so pnpm puts it in the root bin, not the Gateway's.
    const tsx = [
      join(dir, "node_modules", ".bin", "tsx"),
      join(dir, "..", "..", "node_modules", ".bin", "tsx"),
    ].find((candidate) => existsSync(candidate));
    if (!tsx) {
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
    const child = spawn(tsx, ["src/main.ts"], {
      cwd: dir,
      env: {
        ...passthrough,
        PATH: process.env.PATH ?? "",
        HOME: homedir(),
        PSYCHE_HOME: this.opts.psycheHome,
      },
      stdio: ["ignore", "inherit", "inherit"],
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

  private uid(): number {
    return this.opts.uid ?? process.getuid?.() ?? 501;
  }

  private plistPath(): string {
    return this.opts.launchAgentsDir
      ? join(this.opts.launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`)
      : launchAgentPath();
  }

  private logDir(): string {
    return join(this.opts.psycheHome, "logs");
  }

  /** The plist this build wants installed, or undefined when no Gateway is bundled. */
  private launchAgentContent(): string | undefined {
    const program = this.opts.bundledProgram;
    if (!program || !existsSync(program)) return undefined;
    const values = { program, psycheHome: this.opts.psycheHome };
    const plist =
      this.opts.bundledPlist && existsSync(this.opts.bundledPlist)
        ? renderPlistTemplate(readFileSync(this.opts.bundledPlist, "utf8"), values)
        : renderLaunchAgentPlist({ ...values, logDir: this.logDir() });
    const keyFile = this.opts.vaultKeyFile?.();
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

  private async waitHealthy(): Promise<boolean> {
    const deadline = Date.now() + (this.opts.healthTimeoutMs ?? 60_000);
    for (;;) {
      if (await this.healthy()) return true;
      if (Date.now() >= deadline) return false;
      await (this.opts.sleep ?? defaultSleep)(500);
    }
  }

  private failed(reason: string): void {
    this.set({ kind: "stopped", mode: "launchd", reason, logs: this.logDir() });
  }

  /**
   * Installs or updates the LaunchAgent for the bundled psyched (a moved or updated app changes
   * the plist), starts it and waits for `/healthz`. A Gateway that already answers while our agent
   * is not loaded (a terminal, another install) is attached to, never doubled.
   */
  async startLaunchAgent(): Promise<void> {
    const uid = this.uid();
    const program = this.opts.bundledProgram ?? "";
    if (isTranslocated(program)) {
      this.set({
        kind: "stopped",
        mode: "launchd",
        reason: "Move Psyche to the Applications folder and open it again",
      });
      return;
    }
    const content = this.launchAgentContent();
    if (content === undefined) {
      this.set({ kind: "stopped", mode: "launchd", reason: "psyched is not bundled" });
      return;
    }
    const plistPath = this.plistPath();
    const loaded = (await this.run("/bin/launchctl", [...launchctl.print(uid)])).code === 0;
    const current = existsSync(plistPath) ? readFileSync(plistPath, "utf8") : undefined;
    const changed = current !== content;
    if (!loaded && (await this.healthy())) {
      // Someone else serves the Gateway on this port; starting ours would crash-loop on bind.
      this.set({ kind: "running", mode: "launchd" });
      return;
    }
    if (changed) {
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
    this.set({ kind: "starting", mode: "launchd" });
    await this.run("/bin/launchctl", [...launchctl.kickstart(uid)]);
    if (await this.waitHealthy()) return this.refresh();
    const printed = await this.run("/bin/launchctl", [...launchctl.print(uid)]);
    const exit = parseLaunchctlPrint(printed.stdout).lastExit;
    const secs = Math.round((this.opts.healthTimeoutMs ?? 60_000) / 1000);
    this.failed(
      `The Gateway did not answer within ${secs} s${exit && exit !== "0" ? ` (last exit code ${exit})` : ""}`,
    );
  }

  async refresh(): Promise<void> {
    const { mode } = this.opts;
    if (mode !== "launchd") {
      if (mode === "external")
        this.set((await this.healthy()) ? { kind: "running", mode } : { kind: "stopped", mode });
      return;
    }
    const printed = await this.run("/bin/launchctl", [...launchctl.print(this.uid())]);
    if (printed.code !== 0) return this.set({ kind: "stopped", mode, reason: "not loaded" });
    const p = parseLaunchctlPrint(printed.stdout);
    this.set(
      p.running
        ? { kind: "running", mode, ...(p.pid ? { pid: p.pid } : {}) }
        : { kind: "stopped", mode },
    );
  }

  /** "Close window": the Gateway keeps running. Dev children stop with the app. */
  async onAppQuit(): Promise<void> {
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }

  /** "Quit Psyche entirely": stops and uninstalls the LaunchAgent so nothing keeps running. */
  async stopEverything(): Promise<void> {
    await this.onAppQuit();
    if (this.opts.mode === "launchd") await this.uninstallLaunchAgent();
    this.set({ kind: "stopped", mode: this.opts.mode, reason: "quit" });
  }

  /** Boots the agent out and removes its plist; the next launch installs it again. */
  async uninstallLaunchAgent(): Promise<void> {
    await this.run("/bin/launchctl", [...launchctl.bootout(this.uid())]);
    rmSync(this.plistPath(), { force: true });
  }
}
