import { type ChildProcess, spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_OUTPUT_CAP_BYTES,
  type ExecRequest,
  type ExecResult,
  PsycheError,
  type SandboxBackendKind,
  type SandboxRunner,
  type SandboxScope,
} from "@psyche/protocol";
import { receiptOf } from "@psyche/sandbox";
import {
  type CapabilityEntry,
  type CapabilityOutcome,
  type CapabilityProvider,
  fail,
  type InvocationContext,
} from "./types.ts";

/** Upper bound for `timeoutMs` on both capabilities unless `hostExec.timeoutMsMax` says otherwise. */
export const EXEC_TIMEOUT_MS_MAX = 600_000;
/** Grace between SIGTERM and SIGKILL for a host process that outlives its timeout or a cancel. */
export const EXEC_HOST_KILL_GRACE_MS = 2_000;
/**
 * Default sandbox scope: one persistent sandbox per node, so `/workspace` survives between
 * calls the way a thread-scoped sandbox does on the Gateway host.
 */
export const EXEC_DEFAULT_SCOPE: SandboxScope = { kind: "thread", id: "node" };

export interface ExecProviderOptions {
  /** Container runner; `exec` is offered only when it reports at least one backend. */
  runner?: SandboxRunner | null;
  /** `exec.host` (security §5.4): Off unless `enabled`, always needs an approval. */
  hostExec?: { enabled: boolean; allowedCwdRoots: string[]; timeoutMsMax?: number };
}

export interface HostExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

const ARGV_SCHEMA = { type: "array", items: { type: "string" }, minItems: 1 };
const ENV_SCHEMA = { type: "object", additionalProperties: { type: "string" } };

/**
 * `exec` runs argv in the node's container sandbox; there is never a fallback to the host when
 * the sandbox fails. `exec.host` is the separate, separately permissioned host shell-less spawn.
 */
export function createExecProvider(options: ExecProviderOptions): CapabilityProvider {
  const runner = options.runner ?? null;
  const host = options.hostExec?.enabled === true ? options.hostExec : null;
  const hostTimeoutMax = host?.timeoutMsMax ?? EXEC_TIMEOUT_MS_MAX;

  async function backends(): Promise<SandboxBackendKind[]> {
    if (!runner) return [];
    try {
      return await runner.backends();
    } catch {
      return [];
    }
  }

  async function sandboxExec(params: unknown, ctx: InvocationContext): Promise<CapabilityOutcome> {
    if (!runner) return fail("unavailable", "no sandbox runner on this node");
    const p = parseObject(params, ["argv", "cwd", "env", "timeoutMs", "scope"]);
    if (!p.ok) return p.outcome;
    const argv = parseArgv(p.value.argv);
    if (!argv) return fail("invalid_params", "argv must be a non-empty array of strings");
    const cwd = p.value.cwd ?? "/workspace";
    if (typeof cwd !== "string" || !path.posix.isAbsolute(cwd) || cwd.includes("\0")) {
      return fail("invalid_params", "cwd must be an absolute container path");
    }
    const env = parseEnv(p.value.env);
    if (env === false) return fail("invalid_params", "env must map names to strings");
    const timeoutMs = parseTimeout(p.value.timeoutMs, EXEC_TIMEOUT_MS_MAX);
    if (timeoutMs === null) {
      return fail("invalid_params", `timeoutMs must be an integer in 1..${EXEC_TIMEOUT_MS_MAX}`);
    }
    const scope = parseScope(p.value.scope);
    if (!scope) return fail("invalid_params", "scope must be {kind: thread|project|task, id}");

    let sandboxId: string;
    try {
      sandboxId = (await runner.ensureSandbox(scope)).id;
    } catch (err) {
      return { ok: false, error: PsycheError.from(err).toPayload() };
    }
    const request: ExecRequest = { sandboxId, argv, cwd, timeoutMs, signal: ctx.signal };
    if (env) request.env = env;
    ctx.emit({ phase: "started", sandboxId });
    let result: ExecResult;
    try {
      result = await runner.exec(request);
    } catch (err) {
      const error = PsycheError.from(err).toPayload();
      const receipt = ctx.receipt({
        kind: "exec",
        outcome: "failed",
        summary: `${argv[0]}: ${error.code}`,
        payload: { sandboxId, argv, cwd, error: error.code },
      });
      return { ok: false, error, receipt };
    }
    ctx.emit({ phase: "exited", exitCode: result.exitCode });
    // The receipt keeps what ran and how it ended; output stays in the result only.
    const { stdout: _stdout, stderr: _stderr, ...payload } = receiptOf(request, result);
    const receipt = ctx.receipt({
      kind: "exec",
      outcome: result.outcome,
      summary: `${argv[0]} exited ${result.timedOut ? "on timeout" : String(result.exitCode)}`,
      payload,
    });
    return { ok: true, result, receipt };
  }

  async function hostExec(params: unknown, ctx: InvocationContext): Promise<CapabilityOutcome> {
    if (!host) return fail("forbidden", "exec.host is disabled on this node");
    if (!ctx.approvalId) {
      return fail("approval_required", "exec.host always needs an approval", {
        details: { reason: "host_exec_always_asks" },
      });
    }
    const p = parseObject(params, ["argv", "cwd", "env", "timeoutMs"]);
    if (!p.ok) return p.outcome;
    const argv = parseArgv(p.value.argv);
    if (!argv) return fail("invalid_params", "argv must be a non-empty array of strings");
    const rawCwd = p.value.cwd;
    if (typeof rawCwd !== "string" || !path.isAbsolute(rawCwd) || rawCwd.includes("\0")) {
      return fail("invalid_params", "cwd must be an absolute path");
    }
    const env = parseEnv(p.value.env);
    if (env === false) return fail("invalid_params", "env must map names to strings");
    const timeoutMs = parseTimeout(p.value.timeoutMs, hostTimeoutMax);
    if (timeoutMs === null) {
      return fail("invalid_params", `timeoutMs must be an integer in 1..${hostTimeoutMax}`);
    }
    let cwd: string;
    try {
      cwd = await fsp.realpath(rawCwd);
      if (!(await fsp.stat(cwd)).isDirectory()) {
        return fail("invalid_params", "cwd is not a directory");
      }
    } catch {
      return fail("not_found", "cwd does not exist");
    }
    const roots = await realRoots(host.allowedCwdRoots);
    if (!roots.some((r) => inside(cwd, r))) {
      return fail("forbidden", "cwd is outside the allowed roots", {
        details: { reason: "outside_roots" },
      });
    }
    if (ctx.signal.aborted) return fail("cancelled", "cancelled before start");

    const run = await runHost(argv, cwd, env ?? {}, timeoutMs, ctx);
    const base = { argv, cwd };
    if ("spawnError" in run) {
      const receipt = ctx.receipt({
        kind: "exec_host",
        outcome: "failed",
        summary: `${argv[0]}: spawn failed (${run.spawnError})`,
        payload: { ...base, exitCode: null, durationMs: 0, timedOut: false, truncated: false },
      });
      if (run.spawnError === "ENOENT") {
        return fail("not_found", `${argv[0]}: command not found`, { receipt });
      }
      if (run.spawnError === "EACCES") {
        return fail("forbidden", `${argv[0]}: permission denied`, {
          details: { reason: "os_permission" },
          receipt,
        });
      }
      return fail("internal", `${argv[0]}: spawn failed (${run.spawnError})`, { receipt });
    }
    const r = run.result;
    // Killed (timeout, cancel) means side effects are unknown: `uncertain`, as in the sandbox.
    const outcome = r.exitCode === 0 ? "ok" : r.exitCode === null ? "uncertain" : "failed";
    const receipt = ctx.receipt({
      kind: "exec_host",
      outcome,
      summary: `${argv[0]} exited ${r.timedOut ? "on timeout" : String(r.exitCode ?? r.signal)}`,
      payload: {
        ...base,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        timedOut: r.timedOut,
        truncated: r.truncated,
      },
    });
    if (run.cancelled) return fail("cancelled", "exec.host cancelled", { receipt });
    return { ok: true, result: r, receipt };
  }

  const execEntry: CapabilityEntry = {
    manifest: {
      name: "exec",
      description: "Run an argv in this node's container sandbox (network off by default).",
      sideEffect: "write",
      targetKind: "command",
      streaming: true,
      inputSchema: {
        type: "object",
        properties: {
          argv: ARGV_SCHEMA,
          cwd: { type: "string", description: "Container path, default /workspace" },
          env: ENV_SCHEMA,
          timeoutMs: { type: "integer", minimum: 1, maximum: EXEC_TIMEOUT_MS_MAX },
          scope: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["thread", "project", "task"] },
              id: { type: "string" },
            },
            required: ["kind", "id"],
            additionalProperties: false,
          },
        },
        required: ["argv"],
        additionalProperties: false,
      },
    },
    handler: sandboxExec,
  };
  const hostEntry: CapabilityEntry = {
    manifest: {
      name: "exec.host",
      description: "Run an argv directly on this machine, no shell. Always needs approval.",
      sideEffect: "destructive",
      targetKind: "command",
      streaming: true,
      inputSchema: {
        type: "object",
        properties: {
          argv: ARGV_SCHEMA,
          cwd: { type: "string", description: "Absolute path inside an allowed root" },
          env: ENV_SCHEMA,
          timeoutMs: { type: "integer", minimum: 1, maximum: hostTimeoutMax },
        },
        required: ["argv", "cwd"],
        additionalProperties: false,
      },
    },
    handler: hostExec,
  };

  return {
    id: "exec",
    async entries() {
      const out: CapabilityEntry[] = [];
      if ((await backends()).length > 0) out.push(execEntry);
      if (host) out.push(hostEntry);
      return out;
    },
    async status() {
      const b = await backends();
      return { sandbox: b.length > 0 ? b : "none", hostExec: host !== null };
    },
  };
}

export type HostRun = { spawnError: string } | { result: HostExecResult; cancelled: boolean };

/** Spawns without a shell, streams capped output as events, enforces timeout and cancel. */
export function runHost(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  ctx: Pick<InvocationContext, "emit" | "signal">,
): Promise<HostRun> {
  const baseEnv: Record<string, string> = {};
  if (process.env.PATH !== undefined) baseEnv.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) baseEnv.HOME = process.env.HOME;
  const started = performance.now();
  let child: ChildProcess;
  try {
    child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env: { ...baseEnv, ...env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return Promise.resolve({ spawnError: typeof code === "string" ? code : "EINVAL" });
  }

  return new Promise((resolve) => {
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const capture = (stream: "stdout" | "stderr") => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const decoder = new StringDecoder("utf8");
      child[stream]?.on("data", (chunk: Buffer) => {
        const room = EXEC_OUTPUT_CAP_BYTES - bytes;
        if (room <= 0) {
          truncated = true;
          return;
        }
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        if (slice.length < chunk.length) truncated = true;
        chunks.push(slice);
        bytes += slice.length;
        const text = decoder.write(slice);
        if (text) ctx.emit({ stream, text });
      });
      return () => {
        const rest = decoder.end();
        if (rest) ctx.emit({ stream, text: rest });
        return Buffer.concat(chunks).toString("utf8");
      };
    };
    const stdout = capture("stdout");
    const stderr = capture("stderr");

    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, EXEC_HOST_KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      ctx.signal.removeEventListener("abort", onAbort);
    };

    child.once("error", (err) => {
      if (settled || child.pid !== undefined) return;
      cleanup();
      const code = (err as { code?: unknown }).code;
      resolve({ spawnError: typeof code === "string" ? code : "EINVAL" });
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      cleanup();
      resolve({
        cancelled,
        result: {
          exitCode,
          signal,
          stdout: stdout(),
          stderr: stderr(),
          truncated,
          timedOut,
          durationMs: Math.round(performance.now() - started),
        },
      });
    });
  });
}

async function realRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of roots) {
    if (!path.isAbsolute(r)) continue;
    try {
      out.push(await fsp.realpath(r));
    } catch {
      // Missing root: matches nothing.
    }
  }
  return out;
}

function inside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}

function parseObject(
  params: unknown,
  allowed: string[],
): { ok: true; value: Record<string, unknown> } | { ok: false; outcome: CapabilityOutcome } {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return { ok: false, outcome: fail("invalid_params", "params must be an object") };
  }
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) {
      return { ok: false, outcome: fail("invalid_params", `unknown param: ${key}`) };
    }
  }
  return { ok: true, value: params as Record<string, unknown> };
}

function parseArgv(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((a) => typeof a === "string" && !a.includes("\0"))) return null;
  if (v[0] === "") return null;
  return [...(v as string[])];
}

/** `undefined` when absent, `false` when malformed. */
function parseEnv(v: unknown): Record<string, string> | undefined | false {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === "" || k.includes("=") || k.includes("\0")) return false;
    if (typeof val !== "string" || val.includes("\0")) return false;
    out[k] = val;
  }
  return out;
}

function parseTimeout(v: unknown, max: number): number | null {
  if (v === undefined) return Math.min(EXEC_DEFAULT_TIMEOUT_MS, max);
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) return null;
  return v;
}

function parseScope(v: unknown): SandboxScope | null {
  if (v === undefined) return { ...EXEC_DEFAULT_SCOPE };
  if (typeof v !== "object" || v === null) return null;
  const { kind, id } = v as { kind?: unknown; id?: unknown };
  if (kind !== "thread" && kind !== "project" && kind !== "task") return null;
  if (typeof id !== "string" || id === "") return null;
  return { kind, id };
}
