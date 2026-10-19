/**
 * Sandbox runner contract (architecture §9; security §5; owner C1, `packages/sandbox`).
 * Per-task containers with network `none` by default. When no container backend is available
 * `ensureSandbox` rejects with `unavailable`: there is NEVER a fallback to the host shell
 * (`exec_host` is a separate, separately permissioned tool). `argv` is an argument array, never
 * a shell string.
 */

export const EXEC_DEFAULT_TIMEOUT_MS = 60_000;
/** stdout and stderr are each capped at 128 KB (architecture §9). */
export const EXEC_OUTPUT_CAP_BYTES = 128 * 1024;

export type SandboxBackendKind = "apple-container" | "docker" | "podman" | "fake";
export type SandboxNetwork = "none" | "proxy";

export interface SandboxScope {
  kind: "thread" | "project" | "task";
  id: string;
}

export interface SandboxInstance {
  id: string;
  scope: SandboxScope;
  backend: SandboxBackendKind;
  network: SandboxNetwork;
  /** Container path of the persistent workspace volume, normally `/workspace`. */
  workspacePath: string;
  status: "ready" | "stopped" | "error";
}

export interface ExecRequest {
  sandboxId: string;
  argv: string[];
  cwd: string;
  /** Explicit env only; vault secrets arrive as `PSYCHE_SECRET_<NAME>` from the injector. */
  env?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  /** `null` when the process was killed (timeout, cancel). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** stdout or stderr hit `EXEC_OUTPUT_CAP_BYTES`. */
  truncated: boolean;
  /** Workspace-relative paths created or modified. */
  filesChanged: string[];
  timedOut: boolean;
  /** Interrupted commands are `uncertain` (architecture §9). */
  outcome: "ok" | "failed" | "uncertain";
}

export interface SandboxRunner {
  /** Which backends this host offers; empty means every `ensureSandbox` fails. */
  backends(): Promise<SandboxBackendKind[]>;
  /** Idempotent per scope. Rejects with `unavailable` when no backend exists. */
  ensureSandbox(
    scope: SandboxScope,
    options?: { network?: SandboxNetwork },
  ): Promise<SandboxInstance>;
  /**
   * Rejects with `invalid_params` for an empty argv, `not_found` for an unknown sandbox, and
   * `cancelled` when the signal is aborted before start. Non-zero exits resolve normally.
   */
  exec(request: ExecRequest): Promise<ExecResult>;
  destroy(sandboxId: string): Promise<void>;
}
