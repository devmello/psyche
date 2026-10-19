import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { PsycheError } from "@psyche/protocol";

/**
 * Runs helper binaries (`ffmpeg`, `ffprobe`, `whisper-cli`). Always an argv array, never a shell
 * string. The Gateway may wrap the runner to confine the binary: under `srt` on macOS (Seatbelt)
 * via `prefix`, or swap in a runner backed by the sandbox on Linux. Audio is untrusted input to
 * a large C decoder, which is why confinement is the Gateway's default.
 */
export interface ProcessRequest {
  argv: string[];
  stdin?: Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;
/** Output cap: 64 MB covers the largest voice note any channel accepts (Telegram 50 MB). */
export const PROCESS_STDOUT_CAP_BYTES = 64 * 1024 * 1024;
const STDERR_CAP_BYTES = 64 * 1024;

export interface LocalProcessRunnerOptions {
  /** Prepended to every argv, e.g. `["srt", "--settings", path, "--"]`. */
  prefix?: string[];
  /** Base environment; defaults to a minimal `{PATH, HOME, LANG}` so no secrets leak in. */
  env?: Record<string, string>;
}

/** Spawns the binary on this host (optionally behind `prefix`). */
export class LocalProcessRunner implements ProcessRunner {
  readonly #opts: LocalProcessRunnerOptions;

  constructor(options: LocalProcessRunnerOptions = {}) {
    this.#opts = options;
  }

  run(request: ProcessRequest): Promise<ProcessResult> {
    const argv = [...(this.#opts.prefix ?? []), ...request.argv];
    const [cmd, ...args] = argv;
    if (cmd === undefined || cmd === "") {
      return Promise.reject(new PsycheError("invalid_params", "empty argv"));
    }
    if (request.signal?.aborted === true) {
      return Promise.reject(new PsycheError("cancelled", `${cmd} cancelled before start`));
    }
    const env = { ...(this.#opts.env ?? minimalEnv()), ...request.env };
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      let outBytes = 0;
      let err = "";
      let timedOut = false;
      let overflow = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, request.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS);
      const onAbort = () => child.kill("SIGKILL");
      request.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (b: Buffer) => {
        outBytes += b.byteLength;
        if (outBytes > PROCESS_STDOUT_CAP_BYTES) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        out.push(b);
      });
      child.stderr.on("data", (b: Buffer) => {
        if (err.length < STDERR_CAP_BYTES) err += b.toString("utf8");
      });
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        reject(
          e.code === "ENOENT"
            ? new PsycheError("unavailable", `${cmd} is not installed`, { cause: e })
            : new PsycheError("internal", `${cmd} failed to start: ${e.message}`, { cause: e }),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        if (request.signal?.aborted === true) {
          reject(new PsycheError("cancelled", `${cmd} cancelled`));
          return;
        }
        if (overflow) {
          reject(
            new PsycheError(
              "invalid_params",
              `${cmd} output exceeded ${PROCESS_STDOUT_CAP_BYTES} bytes`,
            ),
          );
          return;
        }
        const stdout = Buffer.concat(out);
        resolve({
          exitCode: code,
          stdout: new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.byteLength),
          stderr: err.slice(0, STDERR_CAP_BYTES),
          timedOut,
        });
      });
      // EPIPE when the binary exits before reading all input is reported through `close`.
      child.stdin.on("error", () => {});
      if (request.stdin !== undefined) child.stdin.end(request.stdin);
      else child.stdin.end();
    });
  }
}

function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG", "TMPDIR"]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/** Throws a readable `internal` error unless the process exited 0. */
export function assertOk(result: ProcessResult, what: string): ProcessResult {
  if (result.timedOut) throw new PsycheError("timeout", `${what} timed out`, { retryable: true });
  if (result.exitCode !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-3).join(" | ");
    throw new PsycheError("internal", `${what} exited ${result.exitCode}: ${tail}`);
  }
  return result;
}

/** Resolves a binary name against PATH (or returns an absolute path if executable). */
export async function findBinary(
  name: string,
  searchPath: string = process.env.PATH ?? "",
): Promise<string | undefined> {
  const candidates = isAbsolute(name)
    ? [name]
    : searchPath
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, name));
  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return c;
    } catch {
      // keep looking
    }
  }
  return undefined;
}
