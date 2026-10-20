import {
  EXEC_OUTPUT_CAP_BYTES,
  type ExecRequest,
  type ExecResult,
  type SandboxBackendKind,
  type SandboxInstance,
  type SandboxMount,
  type SandboxNetwork,
  type SandboxRunner,
  type SandboxScope,
} from "@psyche/protocol";
import { captureModelVisible } from "../capture.ts";
import { createIdGenerator, type IdGenerator } from "../ids.ts";
import { fail } from "./errors.ts";

export interface ScriptedExec {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  filesChanged?: string[];
  /** Simulate a command that outlives its timeout. */
  timedOut?: boolean;
}

export type ExecMatcher = string[] | ((request: ExecRequest) => boolean);

export interface FakeSandboxRunnerOptions {
  /** `null` simulates a host with no container backend. Default `"fake"`. */
  backend?: SandboxBackendKind | null;
  ids?: IdGenerator;
}

function cap(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= EXEC_OUTPUT_CAP_BYTES) return { text, truncated: false };
  return { text: bytes.subarray(0, EXEC_OUTPUT_CAP_BYTES).toString("utf8"), truncated: true };
}

/**
 * Scripted sandbox runner. It never touches the host: nothing is spawned. Commands resolve from
 * scripts (`script(["git", "status"], {...})`, prefix match on argv), then from tiny builtins
 * (`echo`, `true`, `false`), else exit 127. With `backend: null` every `ensureSandbox` fails
 * with `unavailable`, exactly like a real host with no container runtime: no host fallback.
 */
export class FakeSandboxRunner implements SandboxRunner {
  readonly execs: ExecRequest[] = [];
  readonly #untrusted = new Map<string, Set<string>>();
  #backend: SandboxBackendKind | null;
  #ids: IdGenerator;
  #sandboxes = new Map<string, SandboxInstance>();
  #scripts: { match: ExecMatcher; result: ScriptedExec }[] = [];

  constructor(options: FakeSandboxRunnerOptions = {}) {
    this.#backend = options.backend === undefined ? "fake" : options.backend;
    this.#ids = options.ids ?? createIdGenerator();
  }

  script(match: ExecMatcher, result: ScriptedExec): this {
    this.#scripts.push({ match, result });
    return this;
  }

  async backends(): Promise<SandboxBackendKind[]> {
    return this.#backend === null ? [] : [this.#backend];
  }

  async ensureSandbox(
    scope: SandboxScope,
    options: { network?: SandboxNetwork; mounts?: SandboxMount[] } = {},
  ): Promise<SandboxInstance> {
    if (this.#backend === null) {
      return fail("unavailable", "no container backend available; there is no host fallback");
    }
    const mounts = (options.mounts ?? []).map((m) => ({ ...m }));
    for (const m of mounts) {
      if (!m.source.startsWith("/") || !m.target.startsWith("/workspace/")) {
        return fail("forbidden", `mount ${m.source} -> ${m.target} is not allowed`);
      }
    }
    const network = options.network ?? "none";
    for (const s of this.#sandboxes.values()) {
      if (s.scope.kind !== scope.kind || s.scope.id !== scope.id) continue;
      // Mounts and network are fixed when a sandbox is created, as in the real runner.
      if (s.network !== network || mountsKey(s.mounts ?? []) !== mountsKey(mounts)) {
        return fail("conflict", `sandbox for ${scope.kind}:${scope.id} exists with other options`);
      }
      return structuredClone(s);
    }
    const sandbox: SandboxInstance = {
      id: this.#ids.next("sbx"),
      scope: { ...scope },
      backend: this.#backend,
      network,
      workspacePath: "/workspace",
      status: "ready",
      ...(mounts.length === 0 ? {} : { mounts }),
    };
    this.#sandboxes.set(sandbox.id, sandbox);
    return structuredClone(sandbox);
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    if (!Array.isArray(request.argv) || request.argv.length === 0 || request.argv[0] === "") {
      return fail("invalid_params", "argv must be a non-empty argument array");
    }
    if (!this.#sandboxes.has(request.sandboxId)) {
      return fail("not_found", `sandbox ${request.sandboxId} not found`);
    }
    if (request.signal?.aborted === true) return fail("cancelled", "exec aborted before start");
    this.execs.push({ ...request, argv: [...request.argv] });
    const scripted = this.#scripts.find(({ match }) =>
      typeof match === "function" ? match(request) : match.every((a, i) => request.argv[i] === a),
    )?.result;
    const r = scripted ?? builtin(request.argv);
    // Design-07: a command from a tainted turn leaves untrusted files behind; from then on
    // every exec in that workspace is untrusted (a command may have copied the content).
    const untrustedWrite = request.provenance !== "trusted";
    const untrustedFiles = this.#untrustedFiles(request.sandboxId);
    for (const path of r.filesChanged ?? []) {
      if (untrustedWrite || untrustedFiles.size > 0) untrustedFiles.add(path);
      else untrustedFiles.delete(path);
    }
    const provenance = untrustedWrite || untrustedFiles.size > 0 ? "untrusted" : "trusted";
    const timedOut = r.timedOut === true;
    const stdout = cap(r.stdout ?? "");
    const stderr = cap(r.stderr ?? "");
    const exitCode = timedOut ? null : (r.exitCode ?? 0);
    captureModelVisible(
      "tool_result",
      { stdout: stdout.text, stderr: stderr.text },
      {
        where: "FakeSandboxRunner.exec",
      },
    );
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      durationMs: timedOut ? request.timeoutMs : (r.durationMs ?? 1),
      truncated: stdout.truncated || stderr.truncated,
      filesChanged: [...(r.filesChanged ?? [])],
      timedOut,
      outcome: timedOut ? "uncertain" : exitCode === 0 ? "ok" : "failed",
      provenance,
    };
  }

  /** Workspace-relative paths this fake holds as untrusted (design-07), per sandbox. */
  untrustedFiles(sandboxId: string): string[] {
    return [...this.#untrustedFiles(sandboxId)].sort();
  }

  #untrustedFiles(sandboxId: string): Set<string> {
    let set = this.#untrusted.get(sandboxId);
    if (!set) {
      set = new Set();
      this.#untrusted.set(sandboxId, set);
    }
    return set;
  }

  async destroy(sandboxId: string): Promise<void> {
    this.#sandboxes.delete(sandboxId);
  }
}

function mountsKey(mounts: readonly SandboxMount[]): string {
  return JSON.stringify(
    mounts.map((m) => [m.source, m.target, m.readOnly]).sort((a, b) => (a < b ? -1 : 1)),
  );
}

function builtin(argv: string[]): ScriptedExec {
  const [cmd, ...rest] = argv;
  if (cmd === "echo") return { stdout: `${rest.join(" ")}\n` };
  if (cmd === "true") return {};
  if (cmd === "false") return { exitCode: 1 };
  return { exitCode: 127, stderr: `${cmd ?? ""}: command not found\n` };
}
