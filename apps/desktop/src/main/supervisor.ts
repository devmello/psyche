import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Gateway lifecycle (feature A7, architecture §3.1). The window is only a client: work continues
 * when it closes because the Gateway runs on its own.
 *
 * - `dev`: unpackaged builds spawn `psyched` from `apps/gateway` as a child (stopped on quit),
 *   unless a Gateway already answers `/healthz`.
 * - `launchd`: packaged builds install and start the LaunchAgent `com.psyche.gateway`. The plist
 *   is S22's (`deploy/launchd/com.psyche.gateway.plist`); when the app bundle carries it, that
 *   copy wins, otherwise `renderLaunchAgentPlist` writes the same keys.
 * - `external`: never start anything (tests, a Gateway on another machine via SSH tunnel).
 */

export type SupervisorMode = "dev" | "launchd" | "external";

export const LAUNCH_AGENT_LABEL = "com.psyche.gateway";

export type GatewayRunState =
  | { kind: "unknown" }
  | { kind: "running"; mode: SupervisorMode; pid?: number }
  | { kind: "stopped"; mode: SupervisorMode; reason?: string };

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

/** Reads `state` and `pid` from `launchctl print` output. */
export function parseLaunchctlPrint(out: string): { running: boolean; pid?: number } {
  const state = /^\s*state = (\S+)/m.exec(out)?.[1];
  const pid = /^\s*pid = (\d+)/m.exec(out)?.[1];
  return { running: state === "running", ...(pid ? { pid: Number(pid) } : {}) };
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
  run?: Runner;
  fetch?: typeof fetch;
  onState?: (s: GatewayRunState) => void;
}

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
    if (await this.healthy()) {
      // Something already serves the Gateway (a LaunchAgent, a terminal): attach, never spawn twice.
      this.set({ kind: "running", mode });
      return;
    }
    if (mode === "dev") this.spawnDev();
    else await this.startLaunchAgent();
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

  /** Writes the plist when missing or different, then bootstraps and kickstarts the agent. */
  async startLaunchAgent(): Promise<void> {
    const uid = this.uid();
    const plistPath = this.opts.launchAgentsDir
      ? join(this.opts.launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`)
      : launchAgentPath();
    const program = this.opts.bundledProgram;
    let content: string | undefined;
    if (this.opts.bundledPlist && existsSync(this.opts.bundledPlist)) {
      content = readFileSync(this.opts.bundledPlist, "utf8");
    } else if (program && existsSync(program)) {
      content = renderLaunchAgentPlist({
        program,
        psycheHome: this.opts.psycheHome,
        logDir: join(this.opts.psycheHome, "logs"),
      });
    }
    if (content === undefined) {
      this.set({ kind: "stopped", mode: "launchd", reason: "psyched is not bundled" });
      return;
    }
    const current = existsSync(plistPath) ? readFileSync(plistPath, "utf8") : undefined;
    if (current !== content) {
      mkdirSync(dirname(plistPath), { recursive: true });
      writeFileSync(plistPath, content, { mode: 0o644 });
      await this.run("/bin/launchctl", [...launchctl.bootout(uid)]); // reload a changed plist
    }
    const printed = await this.run("/bin/launchctl", [...launchctl.print(uid)]);
    if (printed.code !== 0)
      await this.run("/bin/launchctl", [...launchctl.bootstrap(uid, plistPath)]);
    await this.run("/bin/launchctl", [...launchctl.kickstart(uid)]);
    await this.refresh();
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

  /** "Quit Psyche entirely": also stops the LaunchAgent so no task keeps running. */
  async stopEverything(): Promise<void> {
    await this.onAppQuit();
    if (this.opts.mode === "launchd")
      await this.run("/bin/launchctl", [...launchctl.bootout(this.uid())]);
    this.set({ kind: "stopped", mode: this.opts.mode, reason: "quit" });
  }
}
