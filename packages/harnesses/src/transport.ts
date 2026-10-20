/**
 * How a Claude Code session reaches the `claude` CLI. The adapter (`claude-code.ts`) speaks the
 * CLI's documented stream-json over the session's stdin / stdout and answers every tool call's
 * `PreToolUse` hook through `gate`; the transport decides where the CLI runs (the sandbox, in
 * psyched: `sandbox-transport.ts`) and how the hook reaches the host. Tests use a fake.
 */

export interface GateRequest {
  /** Claude Code's tool name, e.g. `Edit`, `Bash`. */
  tool: string;
  input: unknown;
  /** Claude Code's id for the call, when the hook input carries one. */
  toolUseId?: string;
  /** Answer the hook: allow, or deny with a reason Claude Code shows the model. */
  respond(decision: { allow: true } | { allow: false; reason: string }): void;
}

export interface ClaudeSessionOptions {
  /** The owner's folder the session works in (already checked against the grants). */
  cwd: string;
  /** The delegating call's run (credential approvals, sandbox scope). */
  run?: { runId: string; threadId: string; taskId?: string; callId: string; taint: boolean };
  /** Extra CLI arguments chosen by the adapter (model, max turns). */
  args: string[];
  signal: AbortSignal;
}

export interface ClaudeSession {
  /** Where the repository is inside the session, for mapping tool paths back to the owner's. */
  containerCwd: string;
  /** One stream-json line to the CLI. */
  send(line: string): void;
  /** Closes the CLI's stdin: it finishes the turn and exits. */
  endInput(): void;
  /** stream-json lines from the CLI. */
  lines: AsyncIterable<string>;
  /** Hook requests, one per tool call the CLI wants to make. */
  gates: AsyncIterable<GateRequest>;
  exited: Promise<{ exitCode: number | null }>;
  kill(): Promise<void>;
}

export interface ClaudeTransport {
  available(): Promise<boolean>;
  start(options: ClaudeSessionOptions): Promise<ClaudeSession>;
}
