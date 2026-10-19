import type { ExecRequest, ExecResult } from "@psyche/protocol";

/**
 * Command receipt (architecture §9, K2): what ran, where, and what it did. Built from the
 * request and result so callers (Activity, the evaluator, the audit log) store one shape.
 * The environment is deliberately absent: it may hold vault-injected secrets.
 */
export interface SandboxReceipt {
  sandboxId: string;
  argv: string[];
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  filesChanged: string[];
  timedOut: boolean;
  outcome: ExecResult["outcome"];
}

export function receiptOf(request: ExecRequest, result: ExecResult): SandboxReceipt {
  return {
    sandboxId: request.sandboxId,
    argv: [...request.argv],
    cwd: request.cwd,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    filesChanged: [...result.filesChanged],
    timedOut: result.timedOut,
    outcome: result.outcome,
  };
}
