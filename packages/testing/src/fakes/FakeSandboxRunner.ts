import {
  EXEC_OUTPUT_CAP_BYTES,
  type ExecRequest,
  type ExecResult,
  type SandboxBackendKind,
  type SandboxInstance,
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
    options: { network?: SandboxNetwork } = {},
  ): Promise<SandboxInstance> {
    if (this.#backend === null) {
      return fail("unavailable", "no container backend available; there is no host fallback");
    }
    for (const s of this.#sandboxes.values()) {
      if (s.scope.kind === scope.kind && s.scope.id === scope.id) return structuredClone(s);
    }
    const sandbox: SandboxInstance = {
      id: this.#ids.next("sbx"),
      scope: { ...scope },
      backend: this.#backend,
      network: options.network ?? "none",
      workspacePath: "/workspace",
      status: "ready",
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
    };
  }

  async destroy(sandboxId: string): Promise<void> {
    this.#sandboxes.delete(sandboxId);
  }
}

function builtin(argv: string[]): ScriptedExec {
  const [cmd, ...rest] = argv;
  if (cmd === "echo") return { stdout: `${rest.join(" ")}\n` };
  if (cmd === "true") return {};
  if (cmd === "false") return { exitCode: 1 };
  return { exitCode: 127, stderr: `${cmd ?? ""}: command not found\n` };
}
