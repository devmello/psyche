import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import {
  GATEWAY_TASK_FOLDER,
  gatewayTaskLeaf,
  gatewayTaskName,
  LEGACY_GATEWAY_TASK,
  taskBelongsTo,
} from "@psyche/hostfs";
import { CliError } from "./errors.ts";
import { type Exec, whereExe, which } from "./exec.ts";

/**
 * Gateway supervision (feature A7, architecture §3.2): a per-user LaunchAgent on macOS, a
 * systemd user unit on Linux, a per-user Task Scheduler task (`\Psyche\Gateway-<SID>`, at logon)
 * on Windows. Compose deployments are supervised by Docker (`restart:`), so the CLI only prints the
 * command there.
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
  // A macOS path whatever host renders it (build-psyched writes the template on a Mac).
  const logDir = posix.join(input.psycheHome, "logs");
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
  <string>${xml(posix.join(logDir, "gateway.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(posix.join(logDir, "gateway.err.log"))}</string>
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

/**
 * Windows (docs/guides/install.md "Windows"): the Gateway runs from a per-user Task Scheduler task
 * at `\Psyche\Gateway-<user SID>` (Task Scheduler names are machine-wide; @psyche/hostfs
 * `gatewayTaskName`), triggered at logon, the same task the desktop app installs
 * (apps/desktop/src/main/supervisor-windows.ts). Task Scheduler has neither environment variables,
 * log redirection nor KeepAlive, and a console program it starts opens a console window, so the
 * task runs
 *
 *   conhost.exe --headless <node.exe> <service-host.mjs> --home <PSYCHE_HOME> -- <program> <args…>
 *
 * `conhost --headless` gives node.exe a console without a window. The service host
 * (SERVICE_HOST_SCRIPT, plain Node, no dependencies) sets PSYCHE_HOME, appends the Gateway's stdout
 * and stderr to `$PSYCHE_HOME\logs\gateway.out.log` / `gateway.err.log`, restarts it when it exits
 * (KeepAlive) and records both pids in `$PSYCHE_HOME\run\gateway-service.pid` / `gateway.pid`.
 * `schtasks /End` only ends conhost, so stopping also ends the service host's process tree.
 *
 * The desktop app passes the vault's key file (`PSYCHE_VAULT_KEY_FILE`, as the macOS LaunchAgent
 * does) through `$PSYCHE_HOME\run\gateway-service.json` (owner-only), which the service host reads
 * at every start and hands to the Gateway's environment alone: the path is on no command line and
 * in no other process's environment.
 *
 * The name was `\Psyche\Gateway` for every account before; `psyche start` and the desktop app
 * replace that task when it belongs to this account (`migrateLegacyTask`).
 */
export const SCHEDULED_TASK_FOLDER = GATEWAY_TASK_FOLDER;
export { LEGACY_GATEWAY_TASK };
/**
 * In the psyched bundle next to psyched.cmd: the task with {{PSYCHED_DIR}}, {{PSYCHE_HOME}},
 * {{USER_ID}} and {{TASK_NAME}}.
 */
export const TASK_TEMPLATE_FILE = "psyche-gateway.task.xml.template";
/** In the psyched bundle and, for `psyche start`, in `$PSYCHE_HOME\run`. */
export const SERVICE_HOST_FILE = "service-host.mjs";
export const SERVICE_PID_FILE = "gateway-service.pid";
export const GATEWAY_PID_FILE = "gateway.pid";
/** In `$PSYCHE_HOME\run`: what the desktop passes to the Gateway (`{"vaultKeyFile": "<path>"}`). */
export const SERVICE_CONFIG_FILE = "gateway-service.json";

/** The Gateway's supervisor inside the scheduled task. Kept free of imports outside node:. */
export const SERVICE_HOST_SCRIPT = `// Psyche Gateway service host for the Windows scheduled task \\Psyche\\Gateway-<SID>
// (apps/cli/src/supervisor.ts SERVICE_HOST_SCRIPT; written by build-psyched.mjs and psyche start).
//   node service-host.mjs --home <PSYCHE_HOME> -- <program> [args...]
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const homeAt = argv.indexOf("--home");
if (sep < 0 || homeAt < 0 || homeAt > sep || !argv[homeAt + 1] || !argv[sep + 1]) {
  process.stderr.write("usage: service-host.mjs --home <PSYCHE_HOME> -- <program> [args...]\\n");
  process.exit(64);
}
const home = argv[homeAt + 1];
const [program, ...args] = argv.slice(sep + 1);
const logs = join(home, "logs");
const run = join(home, "run");
mkdirSync(logs, { recursive: true });
mkdirSync(run, { recursive: true });
writeFileSync(join(run, "${SERVICE_PID_FILE}"), String(process.pid));

const quote = (a) => (/[\\s"&|<>^%]/.test(a) ? \`"\${a.replace(/"/g, '""')}"\` : a);
let child = null;
let stopping = false;
let quickExits = 0;

// What the desktop app passes to the Gateway, read at every start (run\\${SERVICE_CONFIG_FILE},
// owner-only): the vault's key file becomes PSYCHE_VAULT_KEY_FILE in the Gateway's environment
// alone, as the LaunchAgent sets it on macOS; it is on no command line.
function gatewayEnv() {
  const env = { ...process.env, PSYCHE_HOME: home };
  let cfg = null;
  try {
    cfg = JSON.parse(readFileSync(join(run, "${SERVICE_CONFIG_FILE}"), "utf8"));
  } catch {
    cfg = null;
  }
  const keyFile = cfg && typeof cfg === "object" ? cfg.vaultKeyFile : undefined;
  if (typeof keyFile === "string" && keyFile !== "") env.PSYCHE_VAULT_KEY_FILE = keyFile;
  return env;
}

function start() {
  const out = openSync(join(logs, "gateway.out.log"), "a");
  const err = openSync(join(logs, "gateway.err.log"), "a");
  const opts = {
    env: gatewayEnv(),
    stdio: ["ignore", out, err],
    windowsHide: true,
  };
  // A .cmd launcher (psyched.cmd, an npm shim) runs through cmd.exe; everything else directly.
  child = /\\.(cmd|bat)$/i.test(program)
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", \`"\${[program, ...args].map(quote).join(" ")}"\`], {
        ...opts,
        windowsVerbatimArguments: true,
      })
    : spawn(program, args, opts);
  closeSync(out);
  closeSync(err);
  const started = Date.now();
  if (child.pid) writeFileSync(join(run, "${GATEWAY_PID_FILE}"), String(child.pid));
  const again = () => {
    child = null;
    if (stopping) return finish();
    quickExits = Date.now() - started < 10_000 ? quickExits + 1 : 0;
    setTimeout(start, Math.min(30_000, 1000 * 2 ** quickExits));
  };
  child.once("error", (e) => {
    writeFileSync(join(logs, "gateway.err.log"), \`service host: \${e.message}\\n\`, { flag: "a" });
    again();
  });
  child.once("exit", again);
}

function finish() {
  rmSync(join(run, "${GATEWAY_PID_FILE}"), { force: true });
  rmSync(join(run, "${SERVICE_PID_FILE}"), { force: true });
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(sig, () => {
    stopping = true;
    if (!child) finish();
    child.kill();
    setTimeout(finish, 5000).unref();
  });
}
start();
`;

export interface ScheduledTaskInput {
  /** node.exe that runs the service host. */
  node: string;
  /** The service host script (SERVICE_HOST_SCRIPT on disk). */
  serviceHost: string;
  /** What the host starts: node.exe with psyched's arguments, or a psyched(.cmd). */
  program: string;
  args?: readonly string[];
  psycheHome: string;
  /** `DOMAIN\user` the logon trigger and principal name. */
  userId: string;
  /** The task's path (`gatewayTaskName`), the definition's URI. */
  taskName: string;
}

/**
 * One argument as the Microsoft C runtime parses it (what node.exe uses). A trailing backslash
 * would escape the closing quote, so it goes.
 */
export function winQuote(arg: string): string {
  // Flags stay bare; paths are always quoted, so a template placeholder can become one with spaces.
  if (/^[\w.=:-]+$/.test(arg)) return arg;
  const body = arg.replace(/\\+$/, "").replace(/(\\*)"/g, '$1$1\\"');
  return `"${body}"`;
}

/**
 * The scheduled task definition (Task Scheduler schema 1.2). Written UTF-16 with a BOM
 * (writeTaskXml), which is what `schtasks /Create /XML` reads reliably.
 */
export function renderScheduledTaskXml(input: ScheduledTaskInput): string {
  const argv = [
    "--headless",
    input.node,
    input.serviceHost,
    "--home",
    input.psycheHome,
    "--",
    input.program,
    ...(input.args ?? []),
  ];
  const args = argv.map(winQuote).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Psyche</Author>
    <Description>Psyche Gateway (psyched). Installed by the Psyche app or psyche start; logs in ${xml(win32.join(input.psycheHome, "logs"))}.</Description>
    <URI>${xml(input.taskName)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(input.userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(input.userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>%SystemRoot%\\System32\\conhost.exe</Command>
      <Arguments>${xml(args)}</Arguments>
      <WorkingDirectory>${xml(input.psycheHome)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** UTF-16LE with a byte-order mark, as the XML declaration says. */
export function writeTaskXml(file: string, content: string): void {
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]));
}

export function readTaskXml(file: string): string | null {
  try {
    const b = readFileSync(file);
    return b[0] === 0xff && b[1] === 0xfe ? b.subarray(2).toString("utf16le") : b.toString("utf8");
  } catch {
    return null;
  }
}

/** `DOMAIN\user` of the current user, from the environment Windows gives every process. */
export function windowsUserId(env: NodeJS.ProcessEnv): string {
  const user = env.USERNAME ?? "";
  if (!user) throw new CliError("failure", "USERNAME is not set; cannot name the task's user");
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

/**
 * This account's SID, from System32's `whoami /user` (Git for Windows puts its own `whoami`
 * first on PATH). It names the Gateway task (`gatewayTaskName`).
 */
export async function windowsUserSid(s: SupervisorEnv): Promise<string> {
  const whoami = win32.join(s.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
  const r = await s.exec(whoami, ["/user", "/fo", "csv", "/nh"]);
  const sid = /"(S-1-[0-9-]+)"\s*$/m.exec(r.stdout)?.[1];
  if (r.code !== 0 || sid === undefined)
    throw new CliError("failure", "whoami /user did not name this account's SID");
  return sid;
}

/** This account's Gateway task: `\Psyche\Gateway-<SID>` and its name inside `\Psyche\`. */
export interface GatewayTask {
  name: string;
  leaf: string;
  sid: string;
}

export async function gatewayTask(s: SupervisorEnv): Promise<GatewayTask> {
  const sid = await windowsUserSid(s);
  return { name: gatewayTaskName(sid), leaf: gatewayTaskLeaf(sid), sid };
}

export type SupervisorKind = "launchd" | "systemd" | "taskscheduler" | "none";

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
  if (s.platform === "win32") return "taskscheduler";
  if (s.platform === "linux" && (await which(s.exec, "systemctl", s.platform))) {
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
  if (s.platform === "win32") {
    const found = (await whereExe(s.exec, "psyched")) ?? installedPsychedWin32(s.env);
    if (found) return resolve(found);
  } else {
    const r = await s.exec("/bin/sh", ["-c", "command -v psyched"]);
    const found = r.stdout.trim();
    if (r.code === 0 && found) return absolute(found);
  }
  throw new CliError(
    "usage",
    "Cannot find psyched. Install the desktop app (it ships psyched), set PSYCHE_GATEWAY_BIN, or pass --psyched <path>. On a server, use Docker Compose (deploy/README.md).",
  );
}

/**
 * The desktop app's psyched on Windows: Squirrel installs per user into
 * `%LOCALAPPDATA%\Psyche\app-<version>\resources\psyched\psyched.cmd` and keeps older versions
 * beside the newest for a while; the newest wins.
 */
export function installedPsychedWin32(env: NodeJS.ProcessEnv): string | null {
  const root = env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "Psyche") : null;
  if (!root || !existsSync(root)) return null;
  let names: string[];
  try {
    names = readdirSync(root).filter((n) => /^app-\d+\.\d+\.\d+/.test(n));
  } catch {
    return null;
  }
  const num = (n: string) =>
    n
      .slice(4)
      .split(/[.-]/)
      .map((p) => Number.parseInt(p, 10) || 0);
  names.sort((a, b) => {
    const x = num(a);
    const y = num(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (y[i] ?? 0) - (x[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  for (const n of names) {
    const p = win32.join(root, n, "resources", "psyched", "psyched.cmd");
    if (existsSync(p)) return p;
  }
  return null;
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
  if (kind === "taskscheduler") {
    const task = await gatewayTask(s);
    const state = await taskState(s, task);
    const pid = readPid(join(s.home, "run", GATEWAY_PID_FILE));
    return {
      kind,
      installed: state !== null,
      file: task.name,
      running: state === "running",
      ...(state === "running" && pid ? { pid } : {}),
      detail: state ?? "not installed",
    };
  }
  return { kind, installed: false, running: false };
}

const POWERSHELL = "powershell.exe";
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

/**
 * The task's state from Task Scheduler (`ready`, `running`, `disabled`, `queued`), or null when
 * there is no task. Get-ScheduledTask's State is an enum name, not localized like schtasks' table.
 */
export async function taskState(s: SupervisorEnv, task: GatewayTask): Promise<string | null> {
  const r = await s.exec(POWERSHELL, [
    ...PS_ARGS,
    `$t = Get-ScheduledTask -TaskPath '${SCHEDULED_TASK_FOLDER}' -TaskName '${task.leaf}' -ErrorAction SilentlyContinue; if ($t) { [string]$t.State } else { 'none' }`,
  ]);
  const v = r.stdout.trim().toLowerCase();
  if (r.code !== 0 || !v || v === "none") return null;
  return v;
}

function readPid(file: string): number | undefined {
  try {
    const n = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Ends the task and the service host's tree (`schtasks /End` only ends conhost). */
async function endTask(s: SupervisorEnv, name: string): Promise<void> {
  await s.exec("schtasks.exe", ["/End", "/TN", name]);
  const host = readPid(join(s.home, "run", SERVICE_PID_FILE));
  if (host) await s.exec("taskkill.exe", ["/PID", String(host), "/T", "/F"]);
  const gw = readPid(join(s.home, "run", GATEWAY_PID_FILE));
  if (gw) await s.exec("taskkill.exe", ["/PID", String(gw), "/T", "/F"]);
}

/** What the task runs for `program` (a psyched.cmd from the app's bundle, an npm shim, …). */
export async function scheduledTaskInput(
  s: SupervisorEnv,
  program: string,
  taskName: string,
): Promise<ScheduledTaskInput> {
  const serviceHost = join(s.home, "run", SERVICE_HOST_FILE);
  const userId = windowsUserId(s.env);
  // The app's bundle: start its node.exe directly, without cmd.exe in between.
  const bundle = dirname(program);
  const bundledNode = join(bundle, "runtime", "node.exe");
  const gateway = join(bundle, "app", "apps", "gateway", "dist", "main.mjs");
  if (existsSync(bundledNode) && existsSync(gateway)) {
    return {
      node: bundledNode,
      serviceHost,
      program: bundledNode,
      args: ["--max-semi-space-size=4", "--disable-warning=ExperimentalWarning", gateway],
      psycheHome: s.home,
      userId,
      taskName,
    };
  }
  const node = await whereExe(s.exec, "node");
  if (!node) throw new CliError("usage", "node is not on PATH; the Gateway task needs node.exe");
  const cmd = await serviceCommand(s, program);
  return {
    node,
    serviceHost,
    program: cmd.program,
    args: cmd.args,
    psycheHome: s.home,
    userId,
    taskName,
  };
}

/** The XML last registered by `psyche start`, kept to tell whether the task changed. */
export function taskXmlPath(home: string): string {
  return join(home, "run", "psyche-gateway.task.xml");
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
  const shebang = /^#!\s*\/usr\/bin\/env\s+(-S\s+)?node\b/.test(head);
  if (s.platform === "win32") {
    // Windows starts .exe/.cmd/.bat itself; a plain script (shebang or .mjs/.js) needs node.exe.
    if (!shebang && !/\.(m?js|cjs)$/i.test(program)) return { program, args: [] };
    const node = await whereExe(s.exec, "node");
    if (!node) throw new CliError("usage", `${program} is a node script and node is not on PATH`);
    return { program: resolve(node), args: [program] };
  }
  if (!shebang) return { program, args: [] };
  // Not process.execPath: in a compiled `psyche` binary that is the CLI itself, not node.
  const r = await s.exec("/bin/sh", ["-c", "command -v node"]);
  const node = r.stdout.trim();
  if (r.code !== 0 || !node) {
    throw new CliError("usage", `${program} is a node script and node is not on PATH`);
  }
  return { program: absolute(node), args: [program] };
}

/** An absolute path stays as it is (a POSIX path from `command -v` too); others resolve. */
function absolute(p: string): string {
  return posix.isAbsolute(p) || win32.isAbsolute(p) ? p : resolve(p);
}

async function waitUnloaded(s: SupervisorEnv): Promise<void> {
  // `launchctl bootout` returns before the job is gone; bootstrapping too early fails with
  // "Bootstrap failed: 5: Input/output error".
  for (let i = 0; i < 40; i++) {
    if ((await s.exec("/bin/launchctl", ["print", target(s.uid)])).code !== 0) return;
    await new Promise((r) => setTimeout(r, 125));
  }
}

const NO_TASK = /cannot find|does not exist|not exist/i;

/**
 * The shared `\Psyche\Gateway` of earlier versions, when it runs as this account: ends it (and the
 * service host's tree) and deletes it, so the per-user task replaces it. Another account's task is
 * left alone (this account cannot normally even see it). True when one was removed.
 */
export async function migrateLegacyTask(s: SupervisorEnv, task: GatewayTask): Promise<boolean> {
  const q = await s.exec("schtasks.exe", ["/Query", "/TN", LEGACY_GATEWAY_TASK, "/XML"]);
  if (q.code !== 0) return false;
  let userId: string | undefined;
  try {
    userId = windowsUserId(s.env);
  } catch {
    userId = undefined;
  }
  if (!taskBelongsTo(q.stdout, { sid: task.sid, ...(userId ? { userId } : {}) })) return false;
  await endTask(s, LEGACY_GATEWAY_TASK);
  check(
    await s.exec("schtasks.exe", ["/Delete", "/TN", LEGACY_GATEWAY_TASK, "/F"]),
    "schtasks /Delete",
  );
  return true;
}

/**
 * Windows: writes the service host and the task XML under `$PSYCHE_HOME\run`, registers the task
 * (again, when it changed) and runs it. Returns the task path.
 */
async function startScheduledTask(s: SupervisorEnv, program: string): Promise<string> {
  const task = await gatewayTask(s);
  const migrated = await migrateLegacyTask(s, task);
  const input = await scheduledTaskInput(s, program, task.name);
  mkdirSync(join(s.home, "logs"), { recursive: true, mode: 0o700 });
  mkdirSync(join(s.home, "run"), { recursive: true, mode: 0o700 });
  if (readFileSafe(input.serviceHost) !== SERVICE_HOST_SCRIPT)
    writeFileSync(input.serviceHost, SERVICE_HOST_SCRIPT, { mode: 0o600 });
  const xmlFile = taskXmlPath(s.home);
  const content = renderScheduledTaskXml(input);
  const state = await taskState(s, task);
  const changed = migrated || state === null || readTaskXml(xmlFile) !== content;
  if (changed) {
    if (state === "running") await endTask(s, task.name); // the new definition takes over
    writeTaskXml(xmlFile, content);
    check(
      await s.exec("schtasks.exe", ["/Create", "/TN", task.name, "/XML", xmlFile, "/F"]),
      "schtasks /Create",
    );
  } else if (state === "disabled") {
    check(
      await s.exec("schtasks.exe", ["/Change", "/TN", task.name, "/ENABLE"]),
      "schtasks /Change /ENABLE",
    );
  }
  if (changed || state !== "running")
    check(await s.exec("schtasks.exe", ["/Run", "/TN", task.name]), "schtasks /Run");
  return task.name;
}

function readFileSafe(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Installs (or refreshes) the service file and starts it. Returns the file written. */
export async function startService(s: SupervisorEnv, program: string): Promise<string> {
  const kind = await detectSupervisor(s);
  if (kind === "taskscheduler") return startScheduledTask(s, program);
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

/**
 * Stops the service and keeps it from restarting ("Quit Psyche entirely", A7). On Windows, like a
 * launchd bootout, the task stays registered and its logon trigger starts it at the next sign-in.
 */
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
  if (kind === "taskscheduler") {
    const task = await gatewayTask(s);
    if ((await taskState(s, task)) === null) return; // nothing installed: already stopped
    await endTask(s, task.name);
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
  if (kind === "taskscheduler") {
    const task = await gatewayTask(s);
    const state = await taskState(s, task);
    if (state === null)
      throw new CliError("failure", `No scheduled task ${task.name}; run \`psyche start\``);
    await endTask(s, task.name);
    const r = await s.exec("schtasks.exe", ["/Run", "/TN", task.name]);
    check(r, "schtasks /Run");
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
  if (kind === "taskscheduler") {
    const task = await gatewayTask(s);
    const r = await s.exec("schtasks.exe", ["/Run", "/TN", task.name]);
    if (r.code !== 0 && NO_TASK.test(r.stderr + r.stdout))
      throw new CliError("failure", `No scheduled task ${task.name}; run \`psyche start\``);
    check(r, "schtasks /Run");
    return;
  }
  throw new CliError("failure", COMPOSE_HINT);
}
