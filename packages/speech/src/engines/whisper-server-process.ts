import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { availableParallelism } from "node:os";
import { basename, dirname, join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import {
  type WhisperBackend,
  type WhisperRequest,
  type WhisperSegment,
  WhisperServerBackend,
} from "./whisper.ts";

/**
 * A `whisper-server` the Gateway owns (Windows: the pinned runtime in `speech/bin`), so dictation
 * keeps the model loaded between partials:
 *
 * - **On demand.** Nothing runs until a dictation session or a file needs whisper (`warm()` at
 *   `voice.start`, or the first request); it stops after `idleMs` without a request, which hands
 *   the model's memory (~390 MB for base.en) back.
 * - **Loopback and a secret path.** It listens on 127.0.0.1 on a free port the Gateway picked,
 *   and every route (`/inference`, `/load`, `/health`) sits under `--request-path /<128-bit
 *   token>`; whisper-server has no auth of its own and answers CORS `*`, so without the token a
 *   web page or another local process cannot reach it. `--public` points at an empty directory,
 *   so its static-file route serves nothing. It only ever receives WAV the Gateway encoded from
 *   PCM, never an untrusted compressed file.
 * - **Crashes.** An exit that was not asked for is logged; the next request starts it again (a
 *   request in flight is retried once). Three crashes within a minute stop the retries for a
 *   minute (`crash_loop`), so a broken install does not spin.
 * - **Windows.** `windowsHide` (the Task Scheduler Gateway has no console, so a console child
 *   would open a window), a minimal environment, and a pid file so a server orphaned by a
 *   Gateway that died is stopped at the next start (Windows does not end children with their
 *   parent).
 */

export type WhisperServerState = "stopped" | "starting" | "running" | "stopping";

export interface WhisperServerProcessOptions {
  /** Absolute path to `whisper-server(.exe)`. */
  serverPath: string;
  modelPath: string;
  /** Scratch directory: the pid file and the empty `--public` folder. */
  workDir: string;
  threads?: number;
  /** Stop after this long without a request (default 5 min). */
  idleMs?: number;
  /** Model load and bind (default 60 s). */
  startTimeoutMs?: number;
  /** Test seam: the argv to run instead of `[serverPath]` (the server's own flags follow). */
  command?: string[];
  fetch?: typeof fetch;
  /** Registers the port with the Gateway's own-ports list; returns the unregister function. */
  onListening?: (port: number) => (() => void) | undefined;
  log?: (
    level: "debug" | "info" | "warn",
    event: string,
    fields?: Record<string, string | number | boolean | null>,
  ) => void;
  /** Test seam: whether `pid` is a whisper-server left by an earlier Gateway. */
  isStaleServer?: (pid: number) => Promise<boolean>;
}

/** Windows `STATUS_DLL_NOT_FOUND` as a process exit code: the VC++ runtime is missing. */
const STATUS_DLL_NOT_FOUND = 0xc0000135;
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;
/** Start failures that repeat until the install changes. */
const STICKY = new Set(["vcredist_missing", "not_installed", "spawn_failed"]);
const STICKY_MS = 10 * 60_000;

export function defaultWhisperThreads(): number {
  return Math.max(2, Math.min(8, Math.floor(availableParallelism() * 0.75)));
}

export class WhisperServerProcess {
  readonly #o: WhisperServerProcessOptions;
  readonly #fetch: typeof fetch;
  #state: WhisperServerState = "stopped";
  #child: ChildProcess | undefined;
  #baseUrl: string | undefined;
  #starting: Promise<string> | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #unregisterPort: (() => void) | undefined;
  #crashes: number[] = [];
  #stderr = "";
  #reaped = false;
  #lastError: string | undefined;
  #failedAt = 0;
  /** Requests in flight; the idle timer waits for them. */
  #busy = 0;

  constructor(options: WhisperServerProcessOptions) {
    this.#o = options;
    this.#fetch = options.fetch ?? fetch;
  }

  get state(): WhisperServerState {
    return this.#state;
  }

  /** `http://127.0.0.1:<port>/<token>` while running. */
  get baseUrl(): string | undefined {
    return this.#state === "running" ? this.#baseUrl : undefined;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** Why the last start failed or the server last died (`vcredist_missing`, `crash_loop`, …). */
  get lastError(): string | undefined {
    return this.#lastError;
  }

  /**
   * Whether a start can succeed: false after a failure that repeats until something changes
   * (the VC++ runtime or the binary is missing, it cannot be spawned) and during a crash loop,
   * so selection falls through to the next engine instead of failing every dictation.
   */
  get usable(): boolean {
    const now = Date.now();
    // Retried after a while: the owner may have installed the runtime in the meantime.
    if (STICKY.has(this.#lastError ?? "") && now - this.#failedAt < STICKY_MS) return false;
    return this.#crashes.filter((t) => now - t < CRASH_WINDOW_MS).length < CRASH_LIMIT;
  }

  /** Forgets a sticky failure (the runtime was reinstalled). */
  reset(): void {
    this.#lastError = undefined;
    this.#crashes = [];
  }

  /** Starts the server unless it runs; resolves with its base URL. Concurrent calls share. */
  start(): Promise<string> {
    if (this.#state === "running" && this.#baseUrl !== undefined) {
      this.#armIdle();
      return Promise.resolve(this.#baseUrl);
    }
    if (this.#starting !== undefined) return this.#starting;
    const p = this.#start().finally(() => {
      this.#starting = undefined;
    });
    this.#starting = p;
    return p;
  }

  /** Marks a request in flight (the idle timer does not stop the server under it). */
  async use<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
    const base = await this.start();
    this.#busy++;
    this.#disarmIdle();
    try {
      return await fn(base);
    } finally {
      this.#busy--;
      this.#armIdle();
    }
  }

  async stop(): Promise<void> {
    this.#disarmIdle();
    const child = this.#child;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      this.#cleared();
      return;
    }
    this.#state = "stopping";
    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, 5_000);
      child.once("exit", () => {
        clearTimeout(done);
        resolve();
      });
      child.kill();
    });
    this.#cleared();
  }

  #cleared(): void {
    this.#state = "stopped";
    this.#child = undefined;
    this.#baseUrl = undefined;
    this.#unregisterPort?.();
    this.#unregisterPort = undefined;
    try {
      rmSync(this.#pidFile, { force: true });
    } catch {
      // best effort: a leftover pid file is checked against the process name at the next start
    }
  }

  get #pidFile(): string {
    return join(this.#o.workDir, "whisper-server.pid");
  }

  #disarmIdle(): void {
    if (this.#idle !== undefined) clearTimeout(this.#idle);
    this.#idle = undefined;
  }

  #armIdle(): void {
    this.#disarmIdle();
    if (this.#busy > 0 || this.#state !== "running") return;
    this.#idle = setTimeout(
      () => {
        this.#o.log?.("debug", "speech.whisper_server.idle_stop", {});
        void this.stop();
      },
      this.#o.idleMs ?? 5 * 60_000,
    );
    this.#idle.unref?.();
  }

  async #start(): Promise<string> {
    const now = Date.now();
    this.#crashes = this.#crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    if (this.#crashes.length >= CRASH_LIMIT) {
      this.#lastError = "crash_loop";
      throw new PsycheError("unavailable", "whisper-server keeps crashing; retrying in a minute", {
        retryable: true,
        details: { reason: "crash_loop" },
      });
    }
    await mkdir(join(this.#o.workDir, "public"), { recursive: true, mode: 0o700 });
    if (!this.#reaped) {
      this.#reaped = true;
      await this.#reapStale();
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.#launch(await freePort());
      } catch (err) {
        lastErr = err;
        // Another process took the port between the probe and the bind: try another.
        if (!(err instanceof PsycheError && reasonOf(err) === "bind")) break;
      }
    }
    throw lastErr;
  }

  async #launch(port: number): Promise<string> {
    const token = randomBytes(16).toString("hex");
    const requestPath = `/psyche-${token}`;
    const args = [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--request-path",
      requestPath,
      "--public",
      join(this.#o.workDir, "public"),
      "-m",
      this.#o.modelPath,
      "-t",
      String(this.#o.threads ?? defaultWhisperThreads()),
    ];
    const [cmd, ...pre] = this.#o.command ?? [this.#o.serverPath];
    if (cmd === undefined) throw new PsycheError("invalid_params", "empty whisper-server command");
    this.#state = "starting";
    this.#stderr = "";
    const child = spawn(cmd, [...pre, ...args], {
      cwd: this.#o.workDir,
      env: serverEnv(dirname(this.#o.serverPath)),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    const keep = (b: Buffer) => {
      this.#stderr = (this.#stderr + b.toString("utf8")).slice(-4096);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child.once("error", (error) => resolve({ code: null, error }));
      child.once("exit", (code) => resolve({ code }));
    });
    void exited.then(({ code, error }) => this.#onExit(child, code, error));

    const base = `http://127.0.0.1:${port}${requestPath}`;
    try {
      return await this.#awaitReady(child, exited, base, port);
    } catch (err) {
      if (this.#child === child) this.#cleared();
      throw err;
    }
  }

  async #awaitReady(
    child: ChildProcess,
    exited: Promise<{ code: number | null; error?: Error }>,
    base: string,
    port: number,
  ): Promise<string> {
    const deadline = Date.now() + (this.#o.startTimeoutMs ?? 60_000);
    let gone: { code: number | null; error?: Error } | undefined;
    void exited.then((e) => {
      gone = e;
    });
    while (Date.now() < deadline) {
      if (gone !== undefined) break;
      if (await this.#healthy(base)) {
        if (this.#child !== child) break;
        this.#state = "running";
        this.#baseUrl = base;
        this.#lastError = undefined;
        this.#unregisterPort = this.#o.onListening?.(port) ?? undefined;
        if (child.pid !== undefined) {
          await writeFile(this.#pidFile, `${child.pid}\n`, { mode: 0o600 }).catch(() => undefined);
        }
        this.#o.log?.("info", "speech.whisper_server.started", { port, pid: child.pid ?? null });
        this.#armIdle();
        return base;
      }
      await delay(100);
    }
    if (gone === undefined) {
      child.kill();
      await Promise.race([exited, delay(5_000)]);
      this.#lastError = "start_timeout";
      throw new PsycheError("unavailable", "whisper-server did not become ready in time", {
        retryable: true,
        details: { reason: "start_timeout" },
      });
    }
    throw this.#exitError(gone);
  }

  #exitError(e: { code: number | null; error?: Error }): PsycheError {
    this.#failedAt = Date.now();
    const tail = this.#stderr.trim().split(/\r?\n/).slice(-3).join(" | ");
    if (e.error !== undefined) {
      const missing = (e.error as NodeJS.ErrnoException).code === "ENOENT";
      this.#lastError = missing ? "not_installed" : "spawn_failed";
      return new PsycheError(
        "unavailable",
        missing
          ? "whisper-server is not installed"
          : `whisper-server failed to start: ${e.error.message}`,
        { cause: e.error, details: { reason: this.#lastError } },
      );
    }
    if (e.code === STATUS_DLL_NOT_FOUND || e.code === STATUS_DLL_NOT_FOUND - 2 ** 32) {
      this.#lastError = "vcredist_missing";
      return new PsycheError(
        "unavailable",
        "whisper-server needs the Microsoft Visual C++ Redistributable (2015–2022, x64)",
        { details: { reason: "vcredist_missing" } },
      );
    }
    if (/couldn't bind/.test(this.#stderr)) {
      return new PsycheError("unavailable", "whisper-server could not bind its port", {
        retryable: true,
        details: { reason: "bind" },
      });
    }
    this.#lastError = "exited";
    return new PsycheError("unavailable", `whisper-server exited ${e.code}: ${tail}`, {
      retryable: true,
      details: { reason: "exited", exitCode: e.code },
    });
  }

  #onExit(child: ChildProcess, code: number | null, error: Error | undefined): void {
    if (this.#child !== child) return;
    const wasRunning = this.#state === "running";
    const asked = this.#state === "stopping";
    if (!asked && wasRunning) {
      this.#crashes.push(Date.now());
      this.#lastError = "crashed";
      this.#o.log?.("warn", "speech.whisper_server.crashed", {
        code,
        error: error?.message ?? null,
        tail: this.#stderr.trim().split(/\r?\n/).slice(-2).join(" | "),
      });
    }
    if (this.#state !== "starting") this.#cleared();
  }

  async #healthy(base: string): Promise<boolean> {
    try {
      const res = await this.#fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Stops a whisper-server an earlier Gateway left running (its pid file says which). */
  async #reapStale(): Promise<void> {
    const raw = await readFile(this.#pidFile, "utf8").catch(() => "");
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return;
    const stale = await (this.#o.isStaleServer ?? isWhisperServer)(pid).catch(() => false);
    if (stale) {
      try {
        process.kill(pid);
        this.#o.log?.("info", "speech.whisper_server.reaped", { pid });
      } catch {
        // already gone
      }
    }
    await rm(this.#pidFile, { force: true }).catch(() => undefined);
  }
}

/** Whether `pid` runs a `whisper-server` binary (a reused pid of another program is left alone). */
function isWhisperServer(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const [cmd, args] =
      process.platform === "win32"
        ? ["tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]]
        : ["ps", ["-p", String(pid), "-o", "comm="]];
    execFile(cmd, args, { windowsHide: true, timeout: 5_000 }, (err, stdout) => {
      if (err !== null) return resolve(false);
      const name =
        String(stdout)
          .split(/[",\r\n]/)
          .find((s) => s.trim() !== "") ?? "";
      resolve(/^whisper-server(\.exe)?$/i.test(basename(name.trim())));
    });
  });
}

function serverEnv(binDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.platform === "win32") {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    env.SystemRoot = root;
    env.PATH = `${binDir};${join(root, "System32")}`;
    for (const k of ["TEMP", "TMP", "windir", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
  } else {
    env.PATH = `${binDir}:/usr/bin:/bin`;
    for (const k of ["HOME", "LANG", "TMPDIR"]) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
  }
  return env;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const reasonOf = (err: PsycheError): unknown =>
  (err.details as { reason?: unknown } | undefined)?.reason;

export interface ManagedWhisperServerBackendOptions {
  process: WhisperServerProcess;
  /** Cheap readiness: the runtime and the model are installed (does not start the server). */
  ready: () => Promise<boolean>;
  fetch?: typeof fetch;
}

/** `WhisperBackend` over a `WhisperServerProcess`: starts it on demand, retries once after a crash. */
export class ManagedWhisperServerBackend implements WhisperBackend {
  readonly name = "whisper-server";
  readonly #o: ManagedWhisperServerBackendOptions;

  constructor(options: ManagedWhisperServerBackendOptions) {
    this.#o = options;
  }

  async available(): Promise<boolean> {
    return this.#o.process.usable && (await this.#o.ready());
  }

  /** Loads the model ahead of the first request (a dictation session just started). */
  async warm(): Promise<void> {
    if (await this.#o.ready()) await this.#o.process.start();
  }

  async transcribe(request: WhisperRequest): Promise<WhisperSegment[]> {
    try {
      return await this.#once(request);
    } catch (err) {
      // The server died under the request (connection reset or refused): one fresh start.
      if (request.signal?.aborted === true || !isConnectionError(err)) throw err;
      await this.#o.process.stop();
      return this.#once(request);
    }
  }

  #once(request: WhisperRequest): Promise<WhisperSegment[]> {
    return this.#o.process.use((baseUrl) =>
      new WhisperServerBackend({
        baseUrl,
        ...(this.#o.fetch === undefined ? {} : { fetch: this.#o.fetch }),
      }).transcribe(request),
    );
  }
}

function isConnectionError(err: unknown): boolean {
  if (err instanceof PsycheError) return false;
  return err instanceof TypeError || (err as { name?: string })?.name === "SocketError";
}
