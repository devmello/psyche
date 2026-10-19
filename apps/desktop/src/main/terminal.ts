import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

/**
 * Terminal pane host (feature K6; architecture §5, §9; security §5.4).
 *
 * The desktop never decides where a shell runs. It asks the Gateway (`terminal.open`), which
 * returns the exact argv to spawn: a container exec for the per-task sandbox, or a host shell
 * only when `exec_host` is on. This module validates that answer strictly and spawns exactly
 * that argv in a PTY. It never spawns anything else and never falls back to a host shell: any
 * failure becomes `{ unavailable }` for the pane to show.
 *
 * The PTY gets a minimal environment (TERM, LANG, PATH) plus what the Gateway returned, never
 * the desktop's own `process.env`, which can hold tokens.
 */

export type GatewayCall = (method: string, params: unknown) => Promise<unknown>;

export interface PtyDisposable {
  dispose(): void;
}

/** The slice of node-pty's `IPty` this host uses (node-pty's object satisfies it). */
export interface PtyProcess {
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type PtySpawn = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

export interface TerminalHostOptions {
  call: GatewayCall;
  /** Defaults to node-pty's `spawn`, loaded on first use. Tests inject a fake. */
  spawn?: PtySpawn;
}

export interface TerminalOpenParams {
  threadId?: string;
  cwd?: string;
  cols: number;
  rows: number;
}

export interface TerminalOpened {
  sessionId: string;
  target: "sandbox" | "host";
  label: string;
}

export interface TerminalUnavailable {
  unavailable: string;
}

/** What `terminal.open` must return; anything else is rejected. */
export interface TerminalTarget {
  target: "sandbox" | "host";
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  label: string;
}

export type DataListener = (sessionId: string, data: string) => void;
export type ExitListener = (sessionId: string, exitCode: number) => void;

export const MAX_SESSIONS = 8;
export const MAX_WRITE_BYTES = 64 * 1024;
export const FLUSH_INTERVAL_MS = 8;
export const FLUSH_BYTES = 64 * 1024;
export const COLS_RANGE = { min: 1, max: 500 } as const;
export const ROWS_RANGE = { min: 1, max: 200 } as const;

export const MESSAGES = {
  notImplemented: "The Gateway can't open terminals yet.",
  noSandbox: "No sandbox backend is available. Psyche never falls back to the host shell.",
  tooMany: `Too many terminals are open (at most ${MAX_SESSIONS}). Close one to open another.`,
  invalidTarget: "The Gateway returned an invalid terminal target.",
  failed: "The terminal could not be opened.",
} as const;

const MAX_ARGV = 256;
const MAX_ARG_LENGTH = 8192;
const MAX_LABEL_LENGTH = 200;
const MAX_ENV_ENTRIES = 128;
const MAX_MESSAGE_LENGTH = 200;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Session {
  pty: PtyProcess;
  buffer: string[];
  buffered: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  subscriptions: PtyDisposable[];
}

function hasNul(value: string): boolean {
  return value.includes("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict check of the Gateway's `terminal.open` result. Returns null when it is malformed. */
export function parseTerminalTarget(value: unknown): TerminalTarget | null {
  if (!isRecord(value)) return null;
  const { target, argv, cwd, env, label } = value;
  if (target !== "sandbox" && target !== "host") return null;
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV) return null;
  const args: string[] = [];
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.length > MAX_ARG_LENGTH || hasNul(arg)) return null;
    args.push(arg);
  }
  const file = args[0];
  if (file === undefined || !isAbsolute(file)) return null;
  if (typeof cwd !== "string" || !isAbsolute(cwd) || hasNul(cwd)) return null;
  if (typeof label !== "string" || label.trim().length === 0) return null;
  if (label.length > MAX_LABEL_LENGTH || hasNul(label)) return null;
  let parsedEnv: Record<string, string> | undefined;
  if (env !== undefined) {
    if (!isRecord(env)) return null;
    const entries = Object.entries(env);
    if (entries.length > MAX_ENV_ENTRIES) return null;
    parsedEnv = {};
    for (const [key, val] of entries) {
      if (!ENV_KEY.test(key) || typeof val !== "string" || hasNul(val)) return null;
      parsedEnv[key] = val;
    }
  }
  return { target, argv: args, cwd, label, ...(parsedEnv ? { env: parsedEnv } : {}) };
}

/** Maps a failed `terminal.open` call to the message the pane shows. */
export function unavailableMessage(error: unknown): string {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  if (code === "unknown_method" || code === "not_implemented") return MESSAGES.notImplemented;
  if (code === "unavailable") return MESSAGES.noSandbox;
  let message = "";
  if (error instanceof Error) message = error.message;
  else if (isRecord(error) && typeof error.message === "string") message = error.message;
  const short = message.trim().slice(0, MAX_MESSAGE_LENGTH);
  return short.length > 0 ? short : MESSAGES.failed;
}

/** TERM, LANG and PATH only; the desktop's environment never reaches the shell. */
export function baseEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    TERM: "xterm-256color",
    LANG: source.LANG && !hasNul(source.LANG) ? source.LANG : "en_US.UTF-8",
    PATH: source.PATH && !hasNul(source.PATH) ? source.PATH : "/usr/bin:/bin:/usr/sbin:/sbin",
  };
}

function clamp(value: number, range: { min: number; max: number }): number {
  if (!Number.isFinite(value)) return range.min;
  return Math.min(range.max, Math.max(range.min, Math.floor(value)));
}

export function clampCols(cols: number): number {
  return clamp(cols, COLS_RANGE);
}

export function clampRows(rows: number): number {
  return clamp(rows, ROWS_RANGE);
}

async function loadNodePtySpawn(): Promise<PtySpawn> {
  const pty = await import("node-pty");
  return (file, args, options) => pty.spawn(file, args, options);
}

export class TerminalHost {
  readonly #call: GatewayCall;
  #spawn: PtySpawn | undefined;
  readonly #sessions = new Map<string, Session>();
  readonly #dataListeners = new Set<DataListener>();
  readonly #exitListeners = new Set<ExitListener>();
  #pending = 0;

  constructor(opts: TerminalHostOptions) {
    this.#call = opts.call;
    this.#spawn = opts.spawn;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  async open(params: TerminalOpenParams): Promise<TerminalOpened | TerminalUnavailable> {
    if (this.#sessions.size + this.#pending >= MAX_SESSIONS)
      return { unavailable: MESSAGES.tooMany };
    this.#pending += 1;
    try {
      return await this.#open(params);
    } finally {
      this.#pending -= 1;
    }
  }

  async #open(params: TerminalOpenParams): Promise<TerminalOpened | TerminalUnavailable> {
    const cols = clampCols(params.cols);
    const rows = clampRows(params.rows);
    const request: TerminalOpenParams = { cols, rows };
    if (typeof params.threadId === "string") request.threadId = params.threadId;
    if (typeof params.cwd === "string") request.cwd = params.cwd;

    let result: unknown;
    try {
      result = await this.#call("terminal.open", request);
    } catch (error) {
      return { unavailable: unavailableMessage(error) };
    }
    const target = parseTerminalTarget(result);
    if (!target) return { unavailable: MESSAGES.invalidTarget };
    const [file, ...args] = target.argv;
    if (file === undefined) return { unavailable: MESSAGES.invalidTarget };

    let pty: PtyProcess;
    try {
      this.#spawn ??= await loadNodePtySpawn();
      pty = this.#spawn(file, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: target.cwd,
        env: { ...baseEnv(), ...target.env },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, MAX_MESSAGE_LENGTH) : "";
      return { unavailable: detail ? `${MESSAGES.failed} ${detail}` : MESSAGES.failed };
    }

    const sessionId = `term_${randomUUID()}`;
    const session: Session = { pty, buffer: [], buffered: 0, timer: undefined, subscriptions: [] };
    this.#sessions.set(sessionId, session);
    session.subscriptions.push(
      pty.onData((data) => this.#buffer(sessionId, session, data)),
      pty.onExit(({ exitCode }) => this.#exited(sessionId, session, exitCode)),
    );
    return { sessionId, target: target.target, label: target.label };
  }

  /** Writes keystrokes; drops (returns false) unknown sessions and writes over 64 KB. */
  write(sessionId: string, data: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session || typeof data !== "string") return false;
    if (Buffer.byteLength(data, "utf8") > MAX_WRITE_BYTES) return false;
    session.pty.write(data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    try {
      session.pty.resize(clampCols(cols), clampRows(rows));
    } catch {
      // The PTY may have exited between the check and the call.
      return false;
    }
    return true;
  }

  /** The user closed the tab: kill the PTY without an exit event. */
  close(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#dispose(sessionId, session);
    try {
      session.pty.kill();
    } catch {
      // already gone
    }
  }

  closeAll(): void {
    for (const id of [...this.#sessions.keys()]) this.close(id);
  }

  onData(cb: DataListener): () => void {
    this.#dataListeners.add(cb);
    return () => this.#dataListeners.delete(cb);
  }

  onExit(cb: ExitListener): () => void {
    this.#exitListeners.add(cb);
    return () => this.#exitListeners.delete(cb);
  }

  #buffer(sessionId: string, session: Session, data: string): void {
    if (this.#sessions.get(sessionId) !== session) return;
    session.buffer.push(data);
    session.buffered += data.length;
    if (session.buffered >= FLUSH_BYTES) {
      this.#flush(sessionId, session);
    } else if (session.timer === undefined) {
      session.timer = setTimeout(() => this.#flush(sessionId, session), FLUSH_INTERVAL_MS);
    }
  }

  #flush(sessionId: string, session: Session): void {
    if (session.timer !== undefined) {
      clearTimeout(session.timer);
      session.timer = undefined;
    }
    if (session.buffer.length === 0) return;
    const data = session.buffer.join("");
    session.buffer = [];
    session.buffered = 0;
    for (const cb of this.#dataListeners) cb(sessionId, data);
  }

  #exited(sessionId: string, session: Session, exitCode: number): void {
    if (this.#sessions.get(sessionId) !== session) return;
    this.#flush(sessionId, session);
    this.#dispose(sessionId, session);
    for (const cb of this.#exitListeners) cb(sessionId, exitCode);
  }

  #dispose(sessionId: string, session: Session): void {
    if (session.timer !== undefined) clearTimeout(session.timer);
    session.timer = undefined;
    session.buffer = [];
    session.buffered = 0;
    for (const sub of session.subscriptions) sub.dispose();
    session.subscriptions = [];
    this.#sessions.delete(sessionId);
  }
}
