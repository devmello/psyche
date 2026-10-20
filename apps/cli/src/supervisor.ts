import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliError } from "./errors.ts";
import { type Exec, which } from "./exec.ts";

/**
 * Gateway supervision (feature A7, architecture §3.2): a per-user LaunchAgent on macOS, a
 * systemd user unit on Linux. Compose deployments are supervised by Docker (`restart:`), so the
 * CLI only prints the command there.
 *
 * The plist is byte-identical to what the desktop writes for the same input
 * (apps/desktop/src/main/supervisor.ts), so the two never fight over the file.
 */

export const LAUNCH_AGENT_LABEL = "com.psyche.gateway";
export const SYSTEMD_UNIT = "psyche-gateway.service";

export interface ServiceInput {
  /** Absolute path of the `psyched` executable. */
  program: string;
  args?: readonly string[];
  psycheHome: string;
}

/** Same escaping as the desktop (apostrophes stay literal), so both write identical plists. */
function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * launchd starts agents with `/usr/bin:/bin:/usr/sbin:/sbin`; Homebrew (Apple silicon, then
 * Intel) comes first so tools the Gateway runs, such as the Claude Code and Codex CLIs, are
 * found (#530). Per-user directories (`~/.local/bin`, nvm, …) are searched by the model router.
 */
export const LAUNCH_AGENT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export function renderLaunchAgentPlist(input: ServiceInput): string {
  const logDir = join(input.psycheHome, "logs");
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
  <string>${xml(join(logDir, "gateway.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, "gateway.err.log"))}</string>
</dict>
</plist>
`;
}

/**
 * systemd quoting: double quotes with backslash and quote escaped, `%` doubled (specifiers);
 * `$` doubled only in ExecStart=, where systemd expands variables.
 */
function sdQuote(s: string, exec = false): string {
  let v = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  if (exec) v = v.replace(/\$/g, "$$$$");
  return `"${v}"`;
}

export function renderSystemdUnit(input: ServiceInput): string {
  const exec = [input.program, ...(input.args ?? [])].map((a) => sdQuote(a, true)).join(" ");
  return `# Psyche Gateway as a systemd user service. See deploy/README.md.
# Install: psyche start (writes this file), or copy it to ~/.config/systemd/user/ and run
#   systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_UNIT}
# Keep it running after logout: loginctl enable-linger "$USER"
[Unit]
Description=Psyche Gateway (psyched)
Documentation=https://github.com/devmello/psyche/blob/main/deploy/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
Environment=${sdQuote(`PSYCHE_HOME=${input.psycheHome}`)}
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
# Files 0600, directories 0700 (security §14).
UMask=0077
NoNewPrivileges=yes
LockPersonality=yes
RestrictSUIDSGID=yes
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

export type SupervisorKind = "launchd" | "systemd" | "none";

export interface ServiceState {
  kind: SupervisorKind;
  installed: boolean;
  running: boolean;
  pid?: number;
  file?: string;
  detail?: string;
}

export interface SupervisorEnv {
  env: NodeJS.ProcessEnv;
  exec: Exec;
  platform: NodeJS.Platform;
  uid: number;
  home: string;
}

function userHome(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? homedir();
}

export function launchAgentPath(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

export function systemdUnitPath(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME ?? join(userHome(env), ".config");
  return join(base, "systemd", "user", SYSTEMD_UNIT);
}

export function parseLaunchctlPrint(out: string): { running: boolean; pid?: number } {
  const state = /^\s*state = (\S+)/m.exec(out)?.[1];
  const pid = /^\s*pid = (\d+)/m.exec(out)?.[1];
  return { running: state === "running", ...(pid ? { pid: Number(pid) } : {}) };
}

export async function detectSupervisor(s: SupervisorEnv): Promise<SupervisorKind> {
  if (s.platform === "darwin") return "launchd";
  if (s.platform === "linux" && (await which(s.exec, "systemctl"))) {
    const r = await s.exec("systemctl", ["--user", "show-environment"]);
    if (r.code === 0) return "systemd";
  }
  return "none";
}

/** `psyched` location: `--psyched`, `PSYCHE_GATEWAY_BIN`, then `psyched` on PATH. */
export async function resolvePsyched(s: SupervisorEnv, flag?: string): Promise<string> {
  const candidate = flag ?? s.env.PSYCHE_GATEWAY_BIN;
  if (candidate) {
    if (!existsSync(candidate)) throw new CliError("usage", `psyched not found at ${candidate}`);
    return resolve(candidate);
  }
  const r = await s.exec("/bin/sh", ["-c", "command -v psyched"]);
  const found = r.stdout.trim();
  if (r.code === 0 && found) return resolve(found);
  throw new CliError(
    "usage",
    "Cannot find psyched. Install the desktop app (it ships psyched), set PSYCHE_GATEWAY_BIN, or pass --psyched <path>. On a server, use Docker Compose (deploy/README.md).",
  );
}

const domain = (uid: number) => `gui/${uid}`;
const target = (uid: number) => `gui/${uid}/${LAUNCH_AGENT_LABEL}`;

export async function serviceState(s: SupervisorEnv): Promise<ServiceState> {
  const kind = await detectSupervisor(s);
  if (kind === "launchd") {
    const file = launchAgentPath(s.env);
    const r = await s.exec("/bin/launchctl", ["print", target(s.uid)]);
    const parsed = r.code === 0 ? parseLaunchctlPrint(r.stdout) : { running: false };
    return {
      kind,
      installed: existsSync(file),
      file,
      ...parsed,
      ...(r.code !== 0 ? { detail: "not loaded" } : {}),
    };
  }
  if (kind === "systemd") {
    const file = systemdUnitPath(s.env);
    const active = await s.exec("systemctl", ["--user", "is-active", SYSTEMD_UNIT]);
    const pidOut = await s.exec("systemctl", [
      "--user",
      "show",
      "-p",
      "MainPID",
      "--value",
      SYSTEMD_UNIT,
    ]);
    const pid = Number(pidOut.stdout.trim());
    return {
      kind,
      installed: existsSync(file),
      file,
      running: active.stdout.trim() === "active",
      ...(pid > 0 ? { pid } : {}),
      detail: active.stdout.trim() || undefined,
    } as ServiceState;
  }
  return { kind, installed: false, running: false };
}

function check(r: { code: number; stderr: string; stdout: string }, what: string): void {
  if (r.code !== 0)
    throw new CliError(
      "failure",
      `${what} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`,
    );
}

export const COMPOSE_HINT =
  "No launchd or systemd user session here. On a server, run the Gateway with Docker Compose: docker compose -f deploy/docker-compose.yml up -d (see deploy/README.md).";

/**
 * launchd and systemd start programs with a minimal PATH, so a `#!/usr/bin/env node` script
 * (an npm or pnpm shim) would not find node. Run such scripts with this node's absolute path.
 */
export async function serviceCommand(
  s: SupervisorEnv,
  program: string,
): Promise<{ program: string; args: string[] }> {
  let head = "";
  try {
    head = readFileSync(program, "utf8").slice(0, 128);
  } catch {
    head = "";
  }
  if (!/^#!\s*\/usr\/bin\/env\s+(-S\s+)?node\b/.test(head)) return { program, args: [] };
  // Not process.execPath: in a compiled `psyche` binary that is the CLI itself, not node.
  const r = await s.exec("/bin/sh", ["-c", "command -v node"]);
  const node = r.stdout.trim();
  if (r.code !== 0 || !node) {
    throw new CliError("usage", `${program} is a node script and node is not on PATH`);
  }
  return { program: resolve(node), args: [program] };
}

async function waitUnloaded(s: SupervisorEnv): Promise<void> {
  // `launchctl bootout` returns before the job is gone; bootstrapping too early fails with
  // "Bootstrap failed: 5: Input/output error".
  for (let i = 0; i < 40; i++) {
    if ((await s.exec("/bin/launchctl", ["print", target(s.uid)])).code !== 0) return;
    await new Promise((r) => setTimeout(r, 125));
  }
}

/** Installs (or refreshes) the service file and starts it. Returns the file written. */
export async function startService(s: SupervisorEnv, program: string): Promise<string> {
  const kind = await detectSupervisor(s);
  const input: ServiceInput = { ...(await serviceCommand(s, program)), psycheHome: s.home };
  if (kind === "launchd") {
    const file = launchAgentPath(s.env);
    const content = renderLaunchAgentPlist(input);
    const changed = !existsSync(file) || readFileSync(file, "utf8") !== content;
    mkdirSync(join(s.home, "logs"), { recursive: true, mode: 0o700 });
    if (changed) {
      mkdirSync(join(userHome(s.env), "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(file, content, { mode: 0o644 });
      await s.exec("/bin/launchctl", ["bootout", target(s.uid)]); // reload a changed plist
      await waitUnloaded(s);
    }
    const printed = await s.exec("/bin/launchctl", ["print", target(s.uid)]);
    if (printed.code !== 0)
      check(
        await s.exec("/bin/launchctl", ["bootstrap", domain(s.uid), file]),
        "launchctl bootstrap",
      );
    check(await s.exec("/bin/launchctl", ["kickstart", target(s.uid)]), "launchctl kickstart");
    return file;
  }
  if (kind === "systemd") {
    const file = systemdUnitPath(s.env);
    const content = renderSystemdUnit(input);
    if (!existsSync(file) || readFileSync(file, "utf8") !== content) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, content, { mode: 0o644 });
      check(await s.exec("systemctl", ["--user", "daemon-reload"]), "systemctl daemon-reload");
    }
    check(
      await s.exec("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]),
      "systemctl enable --now",
    );
    return file;
  }
  throw new CliError("failure", COMPOSE_HINT);
}

/** Stops the service and keeps it from restarting ("Quit Psyche entirely", A7). */
export async function stopService(s: SupervisorEnv): Promise<void> {
  const kind = await detectSupervisor(s);
  if (kind === "launchd") {
    const r = await s.exec("/bin/launchctl", ["bootout", target(s.uid)]);
    // 3 / 113: "No such process" / "Could not find service": already stopped.
    if (
      r.code !== 0 &&
      r.code !== 3 &&
      r.code !== 113 &&
      !/No such process|Could not find/i.test(r.stderr)
    ) {
      check(r, "launchctl bootout");
    }
    return;
  }
  if (kind === "systemd") {
    check(await s.exec("systemctl", ["--user", "stop", SYSTEMD_UNIT]), "systemctl stop");
    return;
  }
  throw new CliError("failure", COMPOSE_HINT.replace("up -d", "stop gateway"));
}

export async function restartService(s: SupervisorEnv): Promise<void> {
  const kind = await detectSupervisor(s);
  if (kind === "launchd") {
    check(
      await s.exec("/bin/launchctl", ["kickstart", "-k", target(s.uid)]),
      "launchctl kickstart -k",
    );
    return;
  }
  if (kind === "systemd") {
    check(await s.exec("systemctl", ["--user", "restart", SYSTEMD_UNIT]), "systemctl restart");
    return;
  }
  throw new CliError("failure", COMPOSE_HINT.replace("up -d", "restart gateway"));
}

/** Starts an installed service again after `stopService` (backup `--stop`). */
export async function resumeService(s: SupervisorEnv): Promise<void> {
  const kind = await detectSupervisor(s);
  if (kind === "launchd") {
    const file = launchAgentPath(s.env);
    if (!existsSync(file))
      throw new CliError("failure", `No LaunchAgent at ${file}; run \`psyche start\``);
    const printed = await s.exec("/bin/launchctl", ["print", target(s.uid)]);
    if (printed.code !== 0)
      check(
        await s.exec("/bin/launchctl", ["bootstrap", domain(s.uid), file]),
        "launchctl bootstrap",
      );
    check(await s.exec("/bin/launchctl", ["kickstart", target(s.uid)]), "launchctl kickstart");
    return;
  }
  if (kind === "systemd") {
    check(await s.exec("systemctl", ["--user", "start", SYSTEMD_UNIT]), "systemctl start");
    return;
  }
  throw new CliError("failure", COMPOSE_HINT);
}
