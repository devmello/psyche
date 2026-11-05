import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { defaultSleep, SupervisorBase, type SupervisorOptions } from "./supervisor-base.ts";

/**
 * The Windows Gateway service, the counterpart of the macOS LaunchAgent (feature A7;
 * docs/design/cross-platform-2026.md §3.1 "Task Scheduler at logon"). Packaged builds register a
 * per-user scheduled task that runs the bundled Node runtime on the bundled Gateway:
 *
 *   conhost.exe --headless <resources>\psyched\runtime\node.exe --import <data: preload>
 *               <resources>\psyched\app\apps\gateway\dist\main.mjs
 *
 * - **At logon, kept alive.** A logon trigger (`RunAtLoad`) and a registration trigger (starts it
 *   as soon as it is installed), both repeating every minute with `IgnoreNew`: a Gateway that
 *   exited is started again within a minute (`KeepAlive`); one that runs is left alone. No time
 *   limit, runs on battery, only while the owner is logged on (InteractiveToken, least privilege).
 * - **Hidden.** `node.exe` is a console program: run from a task it would open a console window.
 *   `conhost --headless` hosts that console without a window (Windows 10 1809+). The task is
 *   also marked Hidden in Task Scheduler's list.
 * - **Logs and environment.** A task has no environment block and no stdout redirection, so the
 *   inline preload (a `data:` URL, percent-encoded so no quoting can break it) sets `PSYCHE_HOME`
 *   (and the vault key file), appends stdout/stderr to `$PSYCHE_HOME\logs\gateway.{out,err}.log`
 *   like the plist's `StandardOutPath`, and ends the Gateway (its SIGTERM handler, then exit) when
 *   the hosting conhost goes away: `schtasks /end` stops only the task's own process.
 * - **Per user.** Task names are machine-wide, so the name carries the owner's SID
 *   (`Psyche Gateway-S-1-5-21-…`), like OneDrive's per-user tasks.
 *
 * Plain quit leaves the task running; "Quit Psyche entirely" ends and deletes it. The definition
 * this build wants is kept in `$PSYCHE_HOME\run\gateway-task.xml` (the plist's analogue): a moved
 * or updated app changes it, and the task is replaced. Two copies of Psyche share the task name;
 * one that runs another copy's existing runtime is not taken over without asking.
 */

export const GATEWAY_TASK_PREFIX = "Psyche Gateway";

/** Where the definition this copy installed is kept (compared on every launch). */
export function gatewayTaskFile(psycheHome: string): string {
  return join(psycheHome, "run", "gateway-task.xml");
}

/** The bundled Gateway inside a packaged Windows build (the packaging agent's layout). */
export function bundledGatewayPaths(resourcesPath: string): { node: string; entry: string } {
  const root = join(resourcesPath, "psyched");
  return {
    node: join(root, "runtime", "node.exe"),
    entry: join(root, "app", "apps", "gateway", "dist", "main.mjs"),
  };
}

export function gatewayTaskName(sid: string): string {
  return `${GATEWAY_TASK_PREFIX}-${sid}`;
}

/** `whoami /user /fo csv /nh` → `"host\\user","S-1-5-21-…"`. */
export function parseWhoami(out: string): { user: string; sid: string } | undefined {
  const row = parseCsvRow(out.trim().split(/\r?\n/)[0] ?? "");
  const [user, sid] = row;
  if (!user || !sid || !/^S-1-\d+(-\d+)+$/.test(sid)) return undefined;
  return { user, sid };
}

/** One CSV row as `schtasks` and `whoami` print it (every field quoted, `""` for a quote). */
export function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === ",") {
      i++;
      continue;
    }
    if (line[i] === '"') {
      let v = "";
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          v += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else v += line[i++];
      }
      out.push(v);
    } else {
      const end = line.indexOf(",", i);
      out.push(line.slice(i, end < 0 ? undefined : end));
      i = end < 0 ? line.length : end;
    }
  }
  return out;
}

/** Quotes one argument the way `CommandLineToArgvW` (and conhost, re-joining argv) reads it. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(slashes * 2 + 1);
      out += '"';
    } else {
      out += "\\".repeat(slashes);
      out += ch;
    }
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/** Splits a command line like `CommandLineToArgvW` (enough for the arguments written here). */
export function splitWindowsArgs(line: string): string[] {
  const args: string[] = [];
  let cur = "";
  let quoted = false;
  let any = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (ch === "\\") {
      let n = 0;
      while (line[i] === "\\") {
        n++;
        i++;
      }
      if (line[i] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2 === 1) cur += '"';
        else quoted = !quoted;
      } else {
        cur += "\\".repeat(n);
        i--;
      }
      any = true;
    } else if (ch === '"') {
      quoted = !quoted;
      any = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (any) args.push(cur);
      cur = "";
      any = false;
    } else {
      cur += ch;
      any = true;
    }
  }
  if (any) args.push(cur);
  return args;
}

/**
 * The inline preload: the task's environment, stdout/stderr appended to the log files, and the
 * Gateway's own shutdown when the hosting conhost is gone (`schtasks /end`).
 */
export function gatewayPreloadSource(o: { env: Record<string, string>; logDir: string }): string {
  return [
    `import{openSync as o,writeSync as w,mkdirSync as m}from"node:fs";`,
    `import{join as j}from"node:path";`,
    `Object.assign(process.env,${JSON.stringify(o.env)});`,
    `const L=${JSON.stringify(o.logDir)};m(L,{recursive:true});`,
    `const r=(f)=>function(c,e,b){try{w(f,typeof c=="string"?c:Buffer.from(c))}catch{}`,
    `const k=typeof e=="function"?e:b;if(typeof k=="function")k();return true};`,
    `process.stdout.write=r(o(j(L,"gateway.out.log"),"a"));`,
    `process.stderr.write=r(o(j(L,"gateway.err.log"),"a"));`,
    `const P=process.ppid;const t=setInterval(()=>{try{process.kill(P,0)}catch{clearInterval(t);`,
    `process.emit("SIGTERM");setTimeout(()=>process.exit(0),10000).unref()}},2000);t.unref();`,
  ].join("");
}

/** A `data:` URL with every character but [A-Za-z0-9_.-] percent-encoded (no space, no quote). */
export function dataModuleUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source).replace(
    /[!'()*~]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )}`;
}

export interface GatewayTaskInput {
  /** `<resources>\psyched\runtime\node.exe`. */
  node: string;
  /** `<resources>\psyched\app\apps\gateway\dist\main.mjs`. */
  entry: string;
  psycheHome: string;
  logDir: string;
  /** The owner's SID (`whoami /user`). */
  sid: string;
  /** Extra Gateway environment (`PSYCHE_VAULT_KEY_FILE`); `PSYCHE_HOME` is always set. */
  env?: Record<string, string>;
  /** `%SystemRoot%`, default `C:\Windows`. */
  systemRoot?: string;
}

export function conhostPath(systemRoot = "C:\\Windows"): string {
  return `${systemRoot.replace(/\\+$/, "")}\\System32\\conhost.exe`;
}

/** The argv conhost gets (after its own path). */
export function gatewayTaskArgs(input: GatewayTaskInput): string[] {
  const env = { PSYCHE_HOME: input.psycheHome, ...(input.env ?? {}) };
  return [
    "--headless",
    input.node,
    "--import",
    dataModuleUrl(gatewayPreloadSource({ env, logDir: input.logDir })),
    input.entry,
  ];
}

function xmlText(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function xmlUnescape(s: string): string {
  return s
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

const REPEAT_EVERY_MINUTE =
  "<Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>";

/** The Task Scheduler 1.4 definition (Windows 10+). */
export function renderGatewayTaskXml(input: GatewayTaskInput): string {
  const args = gatewayTaskArgs(input).map(quoteWindowsArg).join(" ");
  const sid = xmlText(input.sid);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Psyche</Author>
    <Description>Runs the Psyche Gateway for this user while they are logged on, so tasks and automations keep running when the Psyche window is closed. Psyche removes it when you choose Quit Psyche entirely.</Description>
    <URI>\\${xmlText(gatewayTaskName(input.sid))}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      ${REPEAT_EVERY_MINUTE}
      <Enabled>true</Enabled>
      <UserId>${sid}</UserId>
    </LogonTrigger>
    <RegistrationTrigger>
      ${REPEAT_EVERY_MINUTE}
      <Enabled>true</Enabled>
    </RegistrationTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${sid}</UserId>
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
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>6</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlText(conhostPath(input.systemRoot))}</Command>
      <Arguments>${xmlText(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** The Node runtime a task definition runs (the argument after `--headless`), XML-unescaped. */
export function taskProgram(xml: string): string | undefined {
  const raw = /<Arguments>([^<]*)<\/Arguments>/.exec(xml)?.[1];
  if (raw === undefined) return undefined;
  const args = splitWindowsArgs(xmlUnescape(raw));
  const at = args.indexOf("--headless");
  return at < 0 ? undefined : args[at + 1];
}

/** `schtasks /create /xml` reads UTF-16 LE with a BOM (what Task Scheduler exports). */
export function encodeTaskXml(xml: string): Buffer {
  return Buffer.from(`\ufeff${xml}`, "utf16le");
}

export function decodeTaskXml(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  const s = buf.toString("utf8");
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** `schtasks.exe` argv (every OS language: only exit codes and fixed CSV columns are read). */
export const schtasks = {
  query: (name: string) => ["/query", "/tn", name],
  queryXml: (name: string) => ["/query", "/tn", name, "/xml"],
  queryVerbose: (name: string) => ["/query", "/tn", name, "/v", "/fo", "csv", "/nh"],
  create: (name: string, xmlFile: string) => ["/create", "/tn", name, "/xml", xmlFile, "/f"],
  run: (name: string) => ["/run", "/tn", name],
  end: (name: string) => ["/end", "/tn", name],
  delete: (name: string) => ["/delete", "/tn", name, "/f"],
} as const;

/** "Last Result" (column 7 of `/v /fo csv`, same in every language): the last exit code. */
export function parseLastResult(csv: string): string | undefined {
  const row = parseCsvRow(csv.trim().split(/\r?\n/)[0] ?? "");
  const v = row[6]?.trim();
  return v && /^-?\d+$/.test(v) ? v : undefined;
}

/** Task Scheduler's "still running" and "never ran" results are not exit codes. */
const NOT_AN_EXIT = new Set(["0", "267009", "267011", "267014"]);

/**
 * Ends Gateways whose command line runs `entry` (backstop after `/end` when the preload's parent
 * watch did not get there): PowerShell, the path passed as a single-quoted literal.
 */
export function killGatewayScript(entry: string): string {
  const lit = `'${entry.replaceAll("'", "''")}'`;
  return `$e=${lit};Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($e) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
}

/** Explorer runs an .exe opened inside a ZIP from a temp copy: a task must never point there. */
export function isTemporaryLocation(path: string, temp = tmpdir()): boolean {
  const p = resolve(path).toLowerCase();
  const t = resolve(temp).toLowerCase();
  return p.startsWith(t.endsWith(sep) ? t : `${t}${sep}`);
}

export interface TaskSchedulerOptions extends SupervisorOptions {
  /** `bundledGatewayPaths(process.resourcesPath)`. */
  bundledNode?: string;
  bundledEntry?: string;
  /** The owner's SID and account; read with `whoami /user` when unset. */
  identity?: { user: string; sid: string };
  /** `%SystemRoot%` (tests). */
  systemRoot?: string;
  /** Default `%SystemRoot%\System32\schtasks.exe`. */
  schtasksPath?: string;
  /** The temp folder a runtime must not run from (tests); default `os.tmpdir()`. */
  tempDir?: string;
}

export class TaskSchedulerSupervisor extends SupervisorBase {
  protected readonly serviceMode = "taskscheduler" as const;
  private readonly win: TaskSchedulerOptions;
  private identity: { user: string; sid: string } | undefined;

  constructor(opts: TaskSchedulerOptions) {
    super(opts);
    this.win = opts;
    this.identity = opts.identity;
  }

  private systemRoot(): string {
    return this.win.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  }

  private system32(exe: string): string {
    return `${this.systemRoot().replace(/\\+$/, "")}\\System32\\${exe}`;
  }

  private schtasks(args: readonly string[]) {
    return this.run(this.win.schtasksPath ?? this.system32("schtasks.exe"), [...args]);
  }

  private async owner(): Promise<{ user: string; sid: string } | undefined> {
    if (this.identity) return this.identity;
    const res = await this.run(this.system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
    this.identity = res.code === 0 ? parseWhoami(res.stdout) : undefined;
    return this.identity;
  }

  /** The task's name for this owner, or undefined when the SID cannot be read. */
  async taskName(): Promise<string | undefined> {
    const who = await this.owner();
    return who ? gatewayTaskName(who.sid) : undefined;
  }

  private async content(sid: string): Promise<string | undefined> {
    const { bundledNode: node, bundledEntry: entry } = this.win;
    if (!node || !entry || !existsSync(node) || !existsSync(entry)) return undefined;
    const keyFile = await this.opts.vaultKeyFile?.();
    return renderGatewayTaskXml({
      node,
      entry,
      sid,
      psycheHome: this.opts.psycheHome,
      logDir: this.logDir(),
      systemRoot: this.systemRoot(),
      ...(keyFile === undefined ? {} : { env: { PSYCHE_VAULT_KEY_FILE: keyFile } }),
    });
  }

  /** The definition Task Scheduler holds now (what another copy may have installed). */
  private async registered(name: string): Promise<string | undefined> {
    const res = await this.schtasks(schtasks.queryXml(name));
    return res.code === 0 ? res.stdout : undefined;
  }

  protected async startService(): Promise<void> {
    const node = this.win.bundledNode ?? "";
    if (node !== "" && isTemporaryLocation(node, this.win.tempDir)) {
      this.set({
        kind: "stopped",
        mode: "taskscheduler",
        reason: "Install Psyche (or extract it from the ZIP) and open it again",
      });
      return;
    }
    const who = await this.owner();
    if (!who) return this.failed("could not read this Windows account's SID");
    const content = await this.content(who.sid);
    if (content === undefined) {
      this.set({ kind: "stopped", mode: "taskscheduler", reason: "psyched is not bundled" });
      return;
    }
    const name = gatewayTaskName(who.sid);
    const file = gatewayTaskFile(this.opts.psycheHome);
    const installed = await this.registered(name);
    const loaded = installed !== undefined;
    const current = loaded && existsSync(file) ? decodeTaskXml(readFileSync(file)) : undefined;
    const changed = current !== content;
    // The file this home's copy wrote is exact; schtasks prints the live one in the OEM code page.
    const other = loaded ? taskProgram(current ?? installed) : undefined;
    if (other !== undefined && other.toLowerCase() !== node.toLowerCase() && existsSync(other)) {
      const takeOver = (await this.opts.confirmTakeover?.(other).catch(() => false)) ?? false;
      if (!takeOver) {
        this.set(
          (await this.healthy())
            ? { kind: "running", mode: "taskscheduler" }
            : {
                kind: "stopped",
                mode: "taskscheduler",
                reason: `Another copy of Psyche runs the Gateway (${other})`,
                logs: this.logDir(),
              },
        );
        return;
      }
    }
    if (!loaded && (await this.healthy())) {
      // Someone else serves the Gateway on this port; starting ours would fail to bind each minute.
      this.set({ kind: "running", mode: "taskscheduler" });
      return;
    }
    mkdirSync(this.opts.psycheHome, { recursive: true, mode: 0o700 });
    mkdirSync(this.logDir(), { recursive: true, mode: 0o700 });
    if (changed) {
      this.set({ kind: "starting", mode: "taskscheduler", step: "installing" });
      // A running Gateway of the old definition (an update moved the runtime) stops first.
      if (loaded) await this.stopTask(name, other ?? this.win.bundledEntry);
      mkdirSync(join(this.opts.psycheHome, "run"), { recursive: true, mode: 0o700 });
      writeFileSync(file, encodeTaskXml(content), { mode: 0o600 });
      if ((await this.schtasks(schtasks.create(name, file))).code !== 0) {
        rmSync(file, { force: true });
        return this.failed("Task Scheduler could not register the Psyche Gateway task");
      }
    }
    if (loaded && !changed && (await this.healthy())) return this.refreshService();
    this.set({ kind: "starting", mode: "taskscheduler", step: "waiting" });
    await this.schtasks(schtasks.run(name));
    if (await this.waitHealthy()) return this.refreshService();
    const exit = parseLastResult((await this.schtasks(schtasks.queryVerbose(name))).stdout);
    const secs = Math.round((this.opts.healthTimeoutMs ?? 60_000) / 1000);
    this.failed(
      `The Gateway did not answer within ${secs} s${exit && !NOT_AN_EXIT.has(exit) ? ` (last exit code ${exit})` : ""}`,
    );
  }

  protected async refreshService(): Promise<void> {
    const name = await this.taskName();
    if (name === undefined || (await this.schtasks(schtasks.query(name))).code !== 0)
      return this.set({ kind: "stopped", mode: "taskscheduler", reason: "not registered" });
    this.set(
      (await this.healthy())
        ? { kind: "running", mode: "taskscheduler" }
        : { kind: "stopped", mode: "taskscheduler" },
    );
  }

  /**
   * Ends the running task and waits for its Gateway to go: the preload ends it within ~2 s of
   * conhost's exit; one that still answers after that is ended by its command line.
   */
  private async stopTask(name: string, marker: string | undefined): Promise<void> {
    await this.schtasks(schtasks.end(name));
    const sleep = this.opts.sleep ?? defaultSleep;
    for (let i = 0; i < 12; i++) {
      if (!(await this.healthy())) return;
      await sleep(500);
    }
    if (marker === undefined) return;
    await this.run(this.system32("WindowsPowerShell\\v1.0\\powershell.exe"), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      killGatewayScript(marker),
    ]);
  }

  /**
   * Ends and deletes the task; the next launch registers it again. A task that runs another
   * copy's runtime is left alone: quitting this copy must not break that install.
   */
  protected async uninstallService(): Promise<void> {
    const name = await this.taskName();
    if (name === undefined) return;
    const installed = await this.registered(name);
    if (installed === undefined) return;
    const file = gatewayTaskFile(this.opts.psycheHome);
    const program = taskProgram(existsSync(file) ? decodeTaskXml(readFileSync(file)) : installed);
    const ours = this.win.bundledNode;
    if (program !== undefined && program.toLowerCase() !== ours?.toLowerCase()) return;
    await this.stopTask(name, this.win.bundledEntry);
    await this.schtasks(schtasks.delete(name));
    rmSync(file, { force: true });
  }
}
