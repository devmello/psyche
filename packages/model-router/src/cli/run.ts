import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { McpToolResult } from "./bridge.ts";

/**
 * One subscription-CLI process (Claude Code or Codex) and the Psyche tool calls it is waiting
 * on. The CLI runs its own agent loop and calls Psyche's tools through the MCP bridge; the
 * adapter ends a model call at those tool calls (`finish{tool_calls}`), the agent loop executes
 * them behind the Permission Broker, and the next model call hands the results back here,
 * which answers the CLI's pending `tools/call` requests and keeps reading its output.
 */

export type CliLine = Record<string, unknown>;

export type CliItem =
  | { type: "line"; value: CliLine }
  | { type: "exit"; code: number | null; signal: string | null; stderr: string; error?: Error };

/** A FIFO the adapter reads across model calls; never loses items between readers. */
export class AsyncQueue<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((r: IteratorResult<T>) => void)[] = [];
  #ended = false;

  push(item: T): void {
    if (this.#ended) return;
    const w = this.#waiters.shift();
    if (w !== undefined) w({ value: item, done: false });
    else this.#items.push(item);
  }

  end(): void {
    this.#ended = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.#ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((r) => this.#waiters.push(r));
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** A tool call the model made, by the CLI's call id. */
export interface PendingCall {
  id: string;
  /** Provider-facing (bridge) tool name. */
  name: string;
  input: unknown;
  result: Deferred<McpToolResult>;
  /** The CLI's `tools/call` for it arrived. */
  claimed: boolean;
  /** The loop handed its result back (possibly before the CLI asked). */
  answered: boolean;
}

export interface CliRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin (each a line); stdin stays open until `endStdin()`. */
  stdin?: string[];
  /** How long an MCP call may wait for the model's matching tool call to be parsed. */
  matchTimeoutMs?: number;
}

const STDERR_MAX = 4000;

export class CliRun {
  readonly items = new AsyncQueue<CliItem>();
  readonly calls = new Map<string, PendingCall>();
  sessionId: string | undefined;
  exited = false;
  readonly #proc: ChildProcess;
  readonly #unmatched: { key: string; got: Deferred<PendingCall> }[] = [];
  readonly #matchTimeoutMs: number;
  #stderr = "";

  constructor(options: CliRunOptions) {
    this.#matchTimeoutMs = options.matchTimeoutMs ?? 30_000;
    const proc = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#proc = proc;
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (d: string) => {
      if (this.#stderr.length < STDERR_MAX) this.#stderr = (this.#stderr + d).slice(0, STDERR_MAX);
    });
    let spawnError: Error | undefined;
    proc.on("error", (err) => {
      spawnError = err;
    });
    const rl = createInterface({ input: proc.stdout as NodeJS.ReadableStream });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t.startsWith("{")) return;
      try {
        this.items.push({ type: "line", value: JSON.parse(t) as CliLine });
      } catch {
        // Not JSON (a banner or a warning): ignore.
      }
    });
    const closed = new Promise<void>((r) => rl.once("close", () => r()));
    proc.on("close", (code, signal) => {
      void closed.then(() => {
        this.exited = true;
        this.items.push({
          type: "exit",
          code,
          signal,
          stderr: this.#stderr,
          ...(spawnError === undefined ? {} : { error: spawnError }),
        });
        this.items.end();
      });
    });
    proc.stdin?.on("error", () => undefined);
    for (const line of options.stdin ?? []) proc.stdin?.write(`${line}\n`);
  }

  write(line: string): void {
    if (!this.exited) this.#proc.stdin?.write(`${line}\n`);
  }

  endStdin(): void {
    this.#proc.stdin?.end();
  }

  kill(): void {
    if (this.exited) return;
    this.#proc.kill("SIGTERM");
    const t = setTimeout(() => {
      if (!this.exited) this.#proc.kill("SIGKILL");
    }, 3000);
    t.unref();
  }

  /** The model asked for a tool (from the CLI's output); its MCP call will claim it. */
  register(id: string, name: string, input: unknown): PendingCall {
    const known = this.calls.get(id);
    if (known !== undefined) return known;
    const call: PendingCall = {
      id,
      name,
      input,
      result: deferred(),
      claimed: false,
      answered: false,
    };
    this.calls.set(id, call);
    const key = `${name}\u0000${stable(input)}`;
    const i = this.#unmatched.findIndex((u) => u.key === key);
    if (i >= 0) {
      const [u] = this.#unmatched.splice(i, 1);
      call.claimed = true;
      u?.got.resolve(call);
    }
    return call;
  }

  /** The CLI's `tools/call`: pair it with the model's call (name + arguments), await the loop. */
  async mcpCall(name: string, args: unknown): Promise<McpToolResult> {
    const key = `${name}\u0000${stable(args)}`;
    let call = [...this.calls.values()].find(
      (c) => !c.claimed && `${c.name}\u0000${stable(c.input)}` === key,
    );
    if (call === undefined) {
      const got = deferred<PendingCall>();
      const entry = { key, got };
      this.#unmatched.push(entry);
      const timer = new Promise<undefined>((r) => {
        const t = setTimeout(() => r(undefined), this.#matchTimeoutMs);
        t.unref();
      });
      call = await Promise.race([got.promise, timer]);
      if (call === undefined) {
        const i = this.#unmatched.indexOf(entry);
        if (i >= 0) this.#unmatched.splice(i, 1);
        return {
          content: [{ type: "text", text: `Psyche did not see a matching call to ${name}.` }],
          isError: true,
        };
      }
    }
    call.claimed = true;
    const result = await call.result.promise;
    this.calls.delete(call.id);
    return result;
  }

  /** Tool calls the loop has not answered yet. */
  unanswered(): string[] {
    return [...this.calls.values()].filter((c) => !c.answered).map((c) => c.id);
  }

  /** Hand the loop's result for one call back to the CLI. */
  resolve(id: string, result: McpToolResult): boolean {
    const call = this.calls.get(id);
    if (call === undefined || call.answered) return false;
    call.answered = true;
    call.result.resolve(result);
    return true;
  }
}
