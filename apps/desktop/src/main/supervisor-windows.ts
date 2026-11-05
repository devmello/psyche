import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { defaultSleep, SupervisorBase, type SupervisorOptions } from "./supervisor-base.ts";

/**
 * The Windows Gateway service, the counterpart of the macOS LaunchAgent (feature A7;
 * docs/design/cross-platform-2026.md §3.1). It is the same per-user scheduled task `psyche start`
 * installs (apps/cli/src/supervisor.ts, Windows branch), so the app and the CLI never fight over
 * it: `\Psyche\Gateway`, at logon, from the template the release bundles next to psyched
 * (`resources\psyched\psyche-gateway.task.xml.template`, deploy/scripts/build-psyched.mjs) with
 * `{{PSYCHED_DIR}}`, `{{PSYCHE_HOME}}` and `{{USER_ID}}` (DOMAIN\user) filled in here. It runs
 *
 *   conhost.exe --headless <psyched>\runtime\node.exe <psyched>\service-host.mjs
 *               --home <PSYCHE_HOME> -- <node.exe> … <psyched>\app\apps\gateway\dist\main.mjs
 *
 * `conhost --headless` gives the console program a console without a window. The service host
 * sets PSYCHE_HOME, appends the Gateway's output to `$PSYCHE_HOME\logs\gateway.{out,err}.log`,
 * restarts it when it exits (KeepAlive) and writes `run\gateway-service.pid` and
 * `run\gateway.pid`; `schtasks /End` only ends conhost, so a stop also ends both process trees.
 *
 * Plain quit leaves the task running; "Quit Psyche entirely" ends and deletes it. The definition
 * last registered is kept in `$PSYCHE_HOME\run\psyche-gateway.task.xml` (the CLI's file too): a
 * moved or updated app changes it and the task is replaced. A task that runs another copy's
 * existing runtime is not taken over without asking.
 */

export const SCHEDULED_TASK = "\\Psyche\\Gateway";
export const TASK_TEMPLATE_FILE = "psyche-gateway.task.xml.template";
export const SERVICE_PID_FILE = "gateway-service.pid";
export const GATEWAY_PID_FILE = "gateway.pid";

/** Where the definition last registered is kept (compared on every launch; shared with the CLI). */
export function gatewayTaskFile(psycheHome: string): string {
  return join(psycheHome, "run", "psyche-gateway.task.xml");
}

/** The bundled Gateway inside a packaged Windows build (`resources\psyched`). */
export function bundledGatewayPaths(resourcesPath: string): {
  dir: string;
  node: string;
  entry: string;
  template: string;
} {
  const dir = join(resourcesPath, "psyched");
  return {
    dir,
    node: join(dir, "runtime", "node.exe"),
    entry: join(dir, "app", "apps", "gateway", "dist", "main.mjs"),
    template: join(dir, TASK_TEMPLATE_FILE),
  };
}

/** `DOMAIN\user` of this account, from the environment Windows gives every process. */
export function windowsUserId(env: NodeJS.ProcessEnv): string | undefined {
  const user = env.USERNAME;
  if (!user) return undefined;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
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

/**
 * Fills the bundled template. The placeholders sit inside quoted arguments and XML text, so the
 * values are XML-escaped; a Windows path holds no `"`, and a trailing backslash would escape the
 * closing quote, so it goes.
 */
export function fillTaskTemplate(
  template: string,
  values: { psychedDir: string; psycheHome: string; userId: string },
): string {
  const path = (p: string) => xmlText(p.replace(/\\+$/, ""));
  return template
    .replaceAll("{{PSYCHED_DIR}}", path(values.psychedDir))
    .replaceAll("{{PSYCHE_HOME}}", path(values.psycheHome))
    .replaceAll("{{USER_ID}}", xmlText(values.userId));
}

/** One CSV row as `schtasks` prints it (every field quoted, `""` for a quote). */
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

/** Quotes one argument the way `CommandLineToArgvW` reads it. */
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
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
}

export function decodeTaskXml(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  const s = buf.toString("utf8");
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** `schtasks.exe` argv (every OS language: only exit codes and fixed CSV columns are read). */
export const schtasks = {
  query: () => ["/Query", "/TN", SCHEDULED_TASK],
  queryXml: () => ["/Query", "/TN", SCHEDULED_TASK, "/XML"],
  queryVerbose: () => ["/Query", "/TN", SCHEDULED_TASK, "/V", "/FO", "CSV", "/NH"],
  create: (xmlFile: string) => ["/Create", "/TN", SCHEDULED_TASK, "/XML", xmlFile, "/F"],
  run: () => ["/Run", "/TN", SCHEDULED_TASK],
  end: () => ["/End", "/TN", SCHEDULED_TASK],
  delete: () => ["/Delete", "/TN", SCHEDULED_TASK, "/F"],
} as const;

/** "Last Result" (column 7 of `/V /FO CSV`, same in every language): the last exit code. */
export function parseLastResult(csv: string): string | undefined {
  const row = parseCsvRow(csv.trim().split(/\r?\n/)[0] ?? "");
  const v = row[6]?.trim();
  return v && /^-?\d+$/.test(v) ? v : undefined;
}

/** Task Scheduler's "still running" and "never ran" results are not exit codes. */
const NOT_AN_EXIT = new Set(["0", "267009", "267011", "267014"]);

/** Explorer runs an .exe opened inside a ZIP from a temp copy: a task must never point there. */
export function isTemporaryLocation(path: string, temp = tmpdir()): boolean {
  const p = resolve(path).toLowerCase();
  const t = resolve(temp).toLowerCase();
  return p.startsWith(t.endsWith(sep) ? t : `${t}${sep}`);
}

function readPid(file: string): number | undefined {
  try {
    const n = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export interface TaskSchedulerOptions extends SupervisorOptions {
  /** `bundledGatewayPaths(process.resourcesPath)`. */
  bundledPsyched?: string;
  bundledNode?: string;
  bundledTemplate?: string;
  /** `DOMAIN\user`; default from USERDOMAIN / USERNAME. */
  userId?: string;
  /** `%SystemRoot%` (tests). */
  systemRoot?: string;
  /** The temp folder a runtime must not run from (tests); default `os.tmpdir()`. */
  tempDir?: string;
}

export class TaskSchedulerSupervisor extends SupervisorBase {
  protected readonly serviceMode = "taskscheduler" as const;
  private readonly win: TaskSchedulerOptions;

  constructor(opts: TaskSchedulerOptions) {
    super(opts);
    this.win = opts;
  }

  private system32(exe: string): string {
    const root = this.win.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
    return `${root.replace(/\\+$/, "")}\\System32\\${exe}`;
  }

  private schtasks(args: readonly string[]) {
    return this.run(this.system32("schtasks.exe"), [...args]);
  }

  /** The definition this build wants, or undefined when no Gateway (or template) is bundled. */
  private content(): string | undefined {
    const { bundledPsyched: dir, bundledNode: node, bundledTemplate: template } = this.win;
    if (!dir || !node || !template || !existsSync(node) || !existsSync(template)) return undefined;
    const userId = this.win.userId ?? windowsUserId(process.env);
    if (!userId) return undefined;
    return fillTaskTemplate(decodeTaskXml(readFileSync(template)), {
      psychedDir: dir,
      psycheHome: this.opts.psycheHome,
      userId,
    });
  }

  private storedDefinition(): string | undefined {
    const file = gatewayTaskFile(this.opts.psycheHome);
    return existsSync(file) ? decodeTaskXml(readFileSync(file)) : undefined;
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
    const content = this.content();
    if (content === undefined) {
      this.set({ kind: "stopped", mode: "taskscheduler", reason: "psyched is not bundled" });
      return;
    }
    const registered = await this.schtasks(schtasks.queryXml());
    const loaded = registered.code === 0;
    const current = loaded ? this.storedDefinition() : undefined;
    const changed = current !== content;
    // The file this home's copy wrote is exact; schtasks prints the live one in the OEM code page.
    const other = loaded ? taskProgram(current ?? registered.stdout) : undefined;
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
      // Someone else serves the Gateway on this port; starting ours would fail to bind.
      this.set({ kind: "running", mode: "taskscheduler" });
      return;
    }
    mkdirSync(this.opts.psycheHome, { recursive: true, mode: 0o700 });
    mkdirSync(this.logDir(), { recursive: true, mode: 0o700 });
    if (changed) {
      this.set({ kind: "starting", mode: "taskscheduler", step: "installing" });
      // A running Gateway of the old definition (an update moved the runtime) stops first.
      if (loaded) await this.stopTask();
      const file = gatewayTaskFile(this.opts.psycheHome);
      mkdirSync(join(this.opts.psycheHome, "run"), { recursive: true, mode: 0o700 });
      writeFileSync(file, encodeTaskXml(content), { mode: 0o600 });
      if ((await this.schtasks(schtasks.create(file))).code !== 0) {
        rmSync(file, { force: true });
        return this.failed("Task Scheduler could not register the Psyche Gateway task");
      }
    }
    if (loaded && !changed && (await this.healthy())) return this.refreshService();
    this.set({ kind: "starting", mode: "taskscheduler", step: "waiting" });
    await this.schtasks(schtasks.run());
    if (await this.waitHealthy()) return this.refreshService();
    const exit = parseLastResult((await this.schtasks(schtasks.queryVerbose())).stdout);
    const secs = Math.round((this.opts.healthTimeoutMs ?? 60_000) / 1000);
    this.failed(
      `The Gateway did not answer within ${secs} s${exit && !NOT_AN_EXIT.has(exit) ? ` (last exit code ${exit})` : ""}`,
    );
  }

  protected async refreshService(): Promise<void> {
    if ((await this.schtasks(schtasks.query())).code !== 0)
      return this.set({ kind: "stopped", mode: "taskscheduler", reason: "not registered" });
    const pid = readPid(join(this.opts.psycheHome, "run", GATEWAY_PID_FILE));
    this.set(
      (await this.healthy())
        ? { kind: "running", mode: "taskscheduler", ...(pid ? { pid } : {}) }
        : { kind: "stopped", mode: "taskscheduler" },
    );
  }

  /**
   * Ends the task and, as `schtasks /End` only ends conhost, the service host's and the
   * Gateway's process trees (their pid files), then waits for `/healthz` to go quiet.
   */
  private async stopTask(): Promise<void> {
    await this.schtasks(schtasks.end());
    for (const f of [SERVICE_PID_FILE, GATEWAY_PID_FILE]) {
      const pid = readPid(join(this.opts.psycheHome, "run", f));
      if (pid) await this.run(this.system32("taskkill.exe"), ["/PID", String(pid), "/T", "/F"]);
    }
    const sleep = this.opts.sleep ?? defaultSleep;
    for (let i = 0; i < 10 && (await this.healthy()); i++) await sleep(500);
  }

  /**
   * Ends and deletes the task; the next launch registers it again. A task that runs another
   * copy's runtime is left alone: quitting this copy must not break that install.
   */
  protected async uninstallService(): Promise<void> {
    const registered = await this.schtasks(schtasks.queryXml());
    if (registered.code !== 0) return;
    const program = taskProgram(this.storedDefinition() ?? registered.stdout);
    const ours = this.win.bundledNode;
    if (program !== undefined && program.toLowerCase() !== ours?.toLowerCase()) return;
    await this.stopTask();
    await this.schtasks(schtasks.delete());
    rmSync(gatewayTaskFile(this.opts.psycheHome), { force: true });
  }
}
