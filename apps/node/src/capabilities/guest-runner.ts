import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import {
  type ExecRequest,
  type ExecResult,
  PsycheError,
  type SandboxBackendKind,
  type SandboxInstance,
  type SandboxRunner,
  type SandboxScope,
} from "@psyche/protocol";
import { runHost } from "./exec.ts";

/**
 * The runner inside the sandbox Mac (VM mode, L1–L5; architecture §10). The guest is the
 * isolation boundary, so a command runs directly on the guest, never on the owner's Mac: no
 * shell, one directory per scope under `root` mapped to `/workspace`, an explicit env (plus the
 * guest's PATH and HOME), the same caps and timeouts as `exec.host`. Offered only when the
 * guest's `node.json` sets `exec.guest.enabled`.
 */
export class GuestRunner implements SandboxRunner {
  readonly #root: string;
  readonly #instances = new Map<string, { instance: SandboxInstance; dir: string }>();

  constructor(options: { root: string }) {
    if (!path.isAbsolute(options.root)) {
      throw new PsycheError("invalid_params", "exec.guest.root must be absolute");
    }
    this.#root = path.resolve(options.root);
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

  async exec(request: ExecRequest): Promise<ExecResult> {
    const entry = this.#instances.get(request.sandboxId);
    if (entry === undefined) throw new PsycheError("not_found", "unknown sandbox");
    if (request.argv.length === 0) throw new PsycheError("invalid_params", "empty argv");
    const signal = request.signal ?? new AbortController().signal;
    if (signal.aborted) throw new PsycheError("cancelled", "exec cancelled");
    const cwd = this.#cwd(entry.dir, request.cwd);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const run = await runHost(request.argv, cwd, request.env ?? {}, request.timeoutMs, {
      emit: () => undefined,
      signal,
    });
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
  }

  async destroy(sandboxId: string): Promise<void> {
    this.#instances.delete(sandboxId);
  }
}
