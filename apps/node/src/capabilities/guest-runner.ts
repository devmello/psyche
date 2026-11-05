import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  type ExecRequest,
  type ExecResult,
  PsycheError,
  type SandboxBackendKind,
  type SandboxInstance,
  type SandboxRunner,
  type SandboxScope,
} from "@psyche/protocol";
import { EXEC_HOST_KILL_GRACE_MS, runHost } from "./exec.ts";

/**
 * The runner inside the sandbox guest (VM mode, L1–L5; architecture §10): the sandbox Mac, or
 * the sandbox PC's Linux guest on Windows. The guest is the isolation boundary, so a command
 * runs directly on the guest, never on the owner's computer: no shell, one directory per scope
 * under `root` mapped to `/workspace`, an explicit env (plus the guest's PATH and HOME), the same
 * caps and timeouts as `exec.host`. Offered only when the guest's `node.json` sets
 * `exec.guest.enabled`.
 *
 * On top of `exec` it runs what the Gateway's srt features need there (scripts, stdio MCP
 * servers): text on stdin, files staged into the workspace first, a throwaway workspace that is
 * removed afterwards, and long-lived sessions with raw pipes (`openSession`). `network: "none"`
 * runs the process in its own empty network namespace; when this guest cannot do that and has a
 * network, the run is refused (never widened).
 */

/** How the guest takes a process off the network. */
export interface GuestNetwork {
  /** `argv` run with no network (loopback only), or `null` when this guest cannot isolate. */
  isolate(argv: string[]): string[] | null;
  /** Whether the guest has a network besides loopback now (unknown counts as online). */
  online(): boolean;
}

const UNSHARE = ["/usr/bin/unshare", "/bin/unshare"];

/** Linux: util-linux `unshare` into a new user + network namespace (no privileges needed). */
export const linuxGuestNetwork: GuestNetwork = {
  isolate(argv) {
    if (process.platform !== "linux") return null;
    const unshare = UNSHARE.find((p) => existsSync(p));
    if (unshare === undefined) return null;
    return [unshare, "--user", "--map-current-user", "--net", "--", ...argv];
  },
  online() {
    try {
      return readdirSync("/sys/class/net").some((n) => n !== "lo");
    } catch {
      return true;
    }
  },
};

/** A file the Gateway stages into the workspace before the process starts. */
export interface GuestFile {
  /** Relative to the run's cwd, `/`-separated, no `..`. */
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

export interface GuestRunRequest extends ExecRequest {
  stdin?: string;
  files?: GuestFile[];
  /** `none`: no network at all; `allow`: the guest's own (none unless its NAT is on). Default allow. */
  network?: "none" | "allow";
  /** Run in a fresh folder under the scope, removed when the process ends. */
  ephemeral?: boolean;
}

export interface GuestSessionRequest {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  files?: GuestFile[];
  network: "none" | "allow";
}

/** A long-lived process with raw pipes (a stdio MCP server in the guest). */
export interface GuestSession {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    durationMs: number;
  }>;
  kill(signal?: "TERM" | "KILL"): void;
}

/** Limits on what one run may stage (the Gateway sends small scripts and connector code). */
export const GUEST_MAX_FILES = 64;
export const GUEST_MAX_FILE_BYTES = 1024 * 1024;
export const GUEST_MAX_STAGED_BYTES = 2 * 1024 * 1024;

export class GuestRunner implements SandboxRunner {
  readonly #root: string;
  readonly #network: GuestNetwork;
  readonly #instances = new Map<string, { instance: SandboxInstance; dir: string }>();

  constructor(options: { root: string; network?: GuestNetwork }) {
    if (!path.isAbsolute(options.root)) {
      throw new PsycheError("invalid_params", "exec.guest.root must be absolute");
    }
    this.#root = path.resolve(options.root);
    this.#network = options.network ?? linuxGuestNetwork;
  }

  async backends(): Promise<SandboxBackendKind[]> {
    return ["vm"];
  }

  async ensureSandbox(scope: SandboxScope): Promise<SandboxInstance> {
    const id = `guest:${scope.kind}:${scope.id}`;
    const have = this.#instances.get(id);
    if (have !== undefined) return { ...have.instance, scope: { ...have.instance.scope } };
    const safe = `${scope.kind}-${scope.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96)}`;
    const dir = path.join(this.#root, safe, "workspace");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const instance: SandboxInstance = {
      id,
      scope: { ...scope },
      backend: "vm",
      network: "none",
      workspacePath: "/workspace",
      status: "ready",
    };
    this.#instances.set(id, { instance, dir });
    return { ...instance, scope: { ...scope } };
  }

  /** `/workspace[/…]` → the scope's directory; anything else, or an escape, is refused. */
  #cwd(dir: string, cwd: string): string {
    const rel = path.posix.relative("/workspace", path.posix.normalize(cwd));
    if (rel.startsWith("..") || path.posix.isAbsolute(rel)) {
      throw new PsycheError("invalid_params", "cwd must be inside /workspace");
    }
    return path.join(dir, ...rel.split("/").filter((p) => p !== ""));
  }

  #entry(sandboxId: string) {
    const entry = this.#instances.get(sandboxId);
    if (entry === undefined) throw new PsycheError("not_found", "unknown sandbox");
    return entry;
  }

  /** The argv to spawn under `network`; refuses what it cannot keep off the network. */
  #argv(argv: string[], network: "none" | "allow"): string[] {
    if (network === "allow") return argv;
    const isolated = this.#network.isolate(argv);
    if (isolated !== null) return isolated;
    if (!this.#network.online()) return argv;
    throw new PsycheError(
      "unavailable",
      "this guest cannot run a process without network while its network is on",
      { details: { reason: "guest_network_isolation" } },
    );
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    return this.run(request);
  }

  async run(request: GuestRunRequest): Promise<ExecResult> {
    const entry = this.#entry(request.sandboxId);
    if (request.argv.length === 0) throw new PsycheError("invalid_params", "empty argv");
    const signal = request.signal ?? new AbortController().signal;
    if (signal.aborted) throw new PsycheError("cancelled", "exec cancelled");
    const argv = this.#argv(request.argv, request.network ?? "allow");
    let base = entry.dir;
    if (request.ephemeral === true) {
      const tmp = path.join(path.dirname(entry.dir), "runs");
      await mkdir(tmp, { recursive: true, mode: 0o700 });
      base = await mkdtemp(path.join(tmp, "run-"));
    }
    try {
      const cwd = this.#cwd(base, request.cwd);
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      await stage(cwd, request.files ?? []);
      const run = await runHost(
        argv,
        cwd,
        request.env ?? {},
        request.timeoutMs,
        { emit: () => undefined, signal },
        request.stdin === undefined ? {} : { stdin: request.stdin },
      );
      if ("spawnError" in run) {
        return {
          exitCode: null,
          stdout: "",
          stderr: `could not start ${request.argv[0]}: ${run.spawnError}`,
          durationMs: 0,
          truncated: false,
          filesChanged: [],
          timedOut: false,
          outcome: "failed",
          provenance: "untrusted",
        };
      }
      const r = run.result;
      return {
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        durationMs: r.durationMs,
        truncated: r.truncated,
        // Not tracked in the guest yet; the Gateway treats every guest result as untrusted.
        filesChanged: [],
        timedOut: r.timedOut,
        outcome: run.cancelled || r.timedOut ? "uncertain" : r.exitCode === 0 ? "ok" : "failed",
        provenance: "untrusted",
      };
    } finally {
      if (base !== entry.dir) await rm(base, { recursive: true, force: true });
    }
  }

  /** Starts a long-lived process with raw pipes in the scope's workspace (no shell). */
  async openSession(sandboxId: string, request: GuestSessionRequest): Promise<GuestSession> {
    const entry = this.#entry(sandboxId);
    if (request.argv.length === 0) throw new PsycheError("invalid_params", "empty argv");
    const argv = this.#argv(request.argv, request.network);
    const cwd = this.#cwd(entry.dir, request.cwd);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await stage(cwd, request.files ?? []);
    const env: Record<string, string> = {};
    if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
    if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
    const started = performance.now();
    const group = process.platform !== "win32";
    const child: ChildProcess = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env: { ...env, ...(request.env ?? {}) },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so a kill reaches what it started (npx → node).
      detached: group,
    });
    const exited = new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      durationMs: number;
    }>((resolve, reject) => {
      child.once("error", (err) => {
        if (child.pid === undefined) reject(err);
      });
      child.once("close", (exitCode, sig) =>
        resolve({ exitCode, signal: sig, durationMs: Math.round(performance.now() - started) }),
      );
    });
    // Spawn failures surface here, before the Gateway is told the session started.
    await new Promise<void>((resolve, reject) => {
      if (child.pid !== undefined) return resolve();
      child.once("spawn", () => resolve());
      exited.catch(reject);
    });
    let killTimer: NodeJS.Timeout | undefined;
    const signalTree = (sig: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        child.kill(sig);
      }
    };
    void exited.finally(() => {
      if (killTimer !== undefined) clearTimeout(killTimer);
    });
    child.stdin?.on("error", () => undefined);
    return {
      stdin: child.stdin as Writable,
      stdout: child.stdout as Readable,
      stderr: child.stderr as Readable,
      exited,
      kill(sig = "TERM") {
        if (sig === "KILL") return signalTree("SIGKILL");
        signalTree("SIGTERM");
        killTimer ??= setTimeout(() => signalTree("SIGKILL"), EXEC_HOST_KILL_GRACE_MS);
        killTimer.unref?.();
      },
    };
  }

  async destroy(sandboxId: string): Promise<void> {
    this.#instances.delete(sandboxId);
  }
}

/** Writes the staged files under `dir`; a path that leaves it is refused before anything runs. */
async function stage(dir: string, files: readonly GuestFile[]): Promise<void> {
  if (files.length > GUEST_MAX_FILES) {
    throw new PsycheError("invalid_params", `at most ${GUEST_MAX_FILES} files`);
  }
  let total = 0;
  const out: { abs: string; data: Buffer }[] = [];
  for (const f of files) {
    const rel = path.posix.normalize(f.path);
    if (
      f.path === "" ||
      f.path.includes("\0") ||
      f.path.includes("\\") ||
      path.posix.isAbsolute(f.path) ||
      rel === "." ||
      rel === ".." ||
      rel.startsWith("../")
    ) {
      throw new PsycheError("invalid_params", `bad file path ${JSON.stringify(f.path)}`);
    }
    const data = Buffer.from(f.content, f.encoding === "base64" ? "base64" : "utf8");
    if (data.length > GUEST_MAX_FILE_BYTES) {
      throw new PsycheError("invalid_params", `${f.path} is larger than ${GUEST_MAX_FILE_BYTES}`);
    }
    total += data.length;
    if (total > GUEST_MAX_STAGED_BYTES) {
      throw new PsycheError("invalid_params", `files over ${GUEST_MAX_STAGED_BYTES} bytes`);
    }
    out.push({ abs: path.join(dir, ...rel.split("/")), data });
  }
  // A process that ran here before may have left symlinks: a staged file never writes through
  // one (its folder must resolve inside `dir`, and the name is created afresh, exclusively).
  const root = await realpath(dir);
  for (const { abs, data } of out) {
    await mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
    const parent = await realpath(path.dirname(abs));
    if (parent !== root && !parent.startsWith(root + path.sep)) {
      throw new PsycheError("invalid_params", `${path.relative(dir, abs)} leaves the workspace`);
    }
    await rm(abs, { force: true, recursive: true });
    await writeFile(abs, data, { mode: 0o600, flag: "wx" });
  }
}
