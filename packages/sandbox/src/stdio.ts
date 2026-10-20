import type { Readable, Writable } from "node:stream";

/**
 * A long-lived process in a sandbox with raw byte pipes (issue #143): what stdio MCP servers
 * need for newline-delimited JSON-RPC. Same container, user, network and no-host-fallback
 * rules as `exec`; unlike `exec` it is not bounded by a timeout and its output is not buffered.
 */
export interface SandboxStdio {
  readonly sandboxId: string;
  /** Raw bytes to the process. Ending it closes the process's stdin. */
  readonly stdin: Writable;
  /** Raw bytes from the process: no PTY, no CRLF translation. */
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** `signal` is set (and `exitCode` null) when `kill` ended the process. */
  readonly exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  /**
   * Output and anything the process writes to `/workspace` are `untrusted` (design-07): a
   * stdio server is third-party code, and its file writes are not observed one by one.
   */
  readonly provenance: "untrusted";
  /** Kills the process group inside the container (TERM, then KILL after a grace period). */
  kill(signal?: "TERM" | "KILL"): Promise<void>;
  /** What ran, once the process has exited. The environment's values are never in it. */
  receipt(): Promise<SandboxStdioReceipt>;
}

export interface OpenStdioOptions {
  /** Validated like `exec`'s argv; resolved on the container's PATH, never through a shell. */
  argv: string[];
  /** Absolute container path; default `/workspace`. */
  cwd?: string;
  /** Delivered on stdin to the relay, never in argv or the CLI's environment. */
  env?: Record<string, string>;
}

export interface SandboxStdioReceipt {
  sandboxId: string;
  argv: string[];
  cwd: string;
  /** Names only: values may be vault-injected secrets. */
  envNames: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  /** `uncertain` when it was killed or its container went away. */
  outcome: "ok" | "failed" | "uncertain";
}
