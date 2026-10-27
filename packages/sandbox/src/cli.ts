import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * The only way this package starts host processes: a fixed executable plus an argument array,
 * `shell: false`. Nothing here ever builds a shell string (architecture §9 "runner hygiene").
 */

export interface CliResult {
  /** `null` when the process ended by signal. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

export interface CliOptions {
  /** Written to stdin, which is then closed. Without it stdin is `/dev/null`. */
  input?: Uint8Array | string;
  /** Per-stream capture cap; the rest is drained and dropped. Default 1 MiB. */
  maxBytes?: number;
  /** Hard host-side limit; SIGKILL when exceeded (container clients may ignore SIGTERM). */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Working directory; the Gateway's own when absent. */
  cwd?: string;
  /**
   * Start the process in its own process group, so `kill` and the timeout reach everything it
   * started (a host command's children, `exec_host`).
   */
  processGroup?: boolean;
}

export interface CliProcess {
  readonly pid: number | undefined;
  readonly done: Promise<CliResult>;
  kill(signal?: NodeJS.Signals): void;
}

/** Long-lived process with raw pipes (PTY relay). */
export interface CliStream {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}

/** Injectable so unit tests can record argv without starting anything. */
export interface CliDriver {
  start(file: string, args: readonly string[], options?: CliOptions): CliProcess;
  stream(file: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }): CliStream;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;

class CappedBuffer {
  #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  push(chunk: Buffer): void {
    const room = this.#max - this.#size;
    if (room <= 0) {
      if (chunk.length > 0) this.truncated = true;
      return;
    }
    if (chunk.length > room) {
      this.#chunks.push(chunk.subarray(0, room));
      this.#size += room;
      this.truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#size += chunk.length;
  }

  value(): Buffer {
    return Buffer.concat(this.#chunks, this.#size);
  }
}

function startProcess(file: string, args: readonly string[], options: CliOptions = {}): CliProcess {
  const started = performance.now();
  const child = spawn(file, [...args], {
    shell: false,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    env: options.env ?? process.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.processGroup === true ? { detached: true } : {}),
    windowsHide: true,
  });
  const signalAll = (signal: NodeJS.Signals) => {
    if (options.processGroup === true && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The group is gone; fall back to the child itself.
      }
    }
    child.kill(signal);
  };
  const out = new CappedBuffer(options.maxBytes ?? DEFAULT_MAX_BYTES);
  const err = new CappedBuffer(options.maxBytes ?? DEFAULT_MAX_BYTES);
  child.stdout?.on("data", (c: Buffer) => out.push(c));
  child.stderr?.on("data", (c: Buffer) => err.push(c));
  if (options.input !== undefined && child.stdin) {
    child.stdin.on("error", () => {
      // EPIPE when the process exits before reading all of stdin; the exit status says enough.
    });
    child.stdin.end(options.input);
  }
  let timer: NodeJS.Timeout | undefined;
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => signalAll("SIGKILL"), options.timeoutMs);
    timer.unref();
  }
  const done = new Promise<CliResult>((resolve, reject) => {
    child.once("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout: out.value(),
        stderr: err.value(),
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
  return {
    pid: child.pid,
    done,
    kill: (signal = "SIGKILL") => {
      if (child.exitCode === null && child.signalCode === null) signalAll(signal);
    },
  };
}

function streamProcess(
  file: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): CliStream {
  const child = spawn(file, [...args], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: options.env ?? process.env,
    windowsHide: true,
  });
  child.stdin.on("error", () => {
    // Writes after the relay exited; `exited` reports the outcome.
  });
  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("error", () => resolve({ exitCode: null, signal: null }));
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    },
  );
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill: (signal = "SIGKILL") => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
  };
}

export const nodeCliDriver: CliDriver = { start: startProcess, stream: streamProcess };

/** Convenience: start and await. */
export function runCli(
  driver: CliDriver,
  file: string,
  args: readonly string[],
  options?: CliOptions,
): Promise<CliResult> {
  return driver.start(file, args, options).done;
}
