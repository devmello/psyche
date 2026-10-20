import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentPlugin, PluginSection, PluginVerdict } from "@psyche/agent-core";
import { type PluginCapability, PsycheError } from "@psyche/protocol";
import { SHIM } from "./shim.ts";

/**
 * One plugin's process (feature T4). Node's permission model confines it: it may read its own
 * folder and nothing else, and may not write files, start processes or workers, or load addons.
 * Its environment is empty, so no Gateway secret or token reaches it; the shim refuses network
 * access. It talks to the Gateway only over stdin / stdout, one JSON line per message, and only
 * about the capabilities its manifest declared.
 */

export const INIT_TIMEOUT_MS = 5_000;
/** Bytes of one reply line; a larger one is dropped and its call fails. */
export const MAX_REPLY_BYTES = 256 * 1024;
/** Bytes of stderr kept for diagnostics. */
const STDERR_CAP = 8 * 1024;

export interface PluginHostOptions {
  name: string;
  /** Real path of the installed folder. */
  dir: string;
  main: string;
  capabilities: readonly PluginCapability[];
  /** Node binary; default this process's (with ELECTRON_RUN_AS_NODE under Electron). */
  nodePath?: string;
  onExit?: (reason: string) => void;
}

export interface PluginHost {
  readonly name: string;
  start(): Promise<void>;
  call(method: string, params: unknown): Promise<unknown>;
  stop(): void;
  /** The last lines the plugin wrote to stderr. */
  stderr(): string;
}

export class PluginProcess implements PluginHost {
  readonly name: string;
  readonly #o: PluginHostOptions;
  #child: ChildProcess | undefined;
  #next = 0;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #stderr = "";
  #stopped = false;

  constructor(options: PluginHostOptions) {
    this.name = options.name;
    this.#o = options;
  }

  async start(): Promise<void> {
    const electron = process.versions.electron !== undefined;
    const child = spawn(
      this.#o.nodePath ?? process.execPath,
      [
        "--permission",
        `--allow-fs-read=${this.#o.dir}`,
        "--input-type=module",
        "--eval",
        SHIM,
        "--",
        join(this.#o.dir, this.#o.main),
      ],
      {
        cwd: this.#o.dir,
        // No secrets, tokens or proxy settings: an empty environment.
        env: electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#child = child;
    child.stderr?.on("data", (b: Buffer) => {
      this.#stderr = (this.#stderr + b.toString("utf8")).slice(-STDERR_CAP);
    });
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    lines.on("line", (line) => this.#reply(line));
    child.on("exit", (code, signal) => {
      const reason = `exited (${signal ?? code})${this.#stderr ? `: ${this.#stderr.trim().split("\n").at(-1)}` : ""}`;
      for (const p of this.#pending.values()) p.reject(new Error(`plugin ${this.name} ${reason}`));
      this.#pending.clear();
      this.#child = undefined;
      if (!this.#stopped) this.#o.onExit?.(reason);
    });
    child.on("error", (err) => {
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const init = (await Promise.race([
        this.call("init", { capabilities: this.#o.capabilities }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`did not start within ${INIT_TIMEOUT_MS} ms`)),
            INIT_TIMEOUT_MS,
          );
        }),
      ])) as { registered?: string[] };
      const extra = (init.registered ?? []).filter(
        (c) => !this.#o.capabilities.includes(c as PluginCapability),
      );
      if (extra.length > 0) throw new Error(`registered undeclared ${extra.join(", ")}`);
    } catch (err) {
      this.stop();
      throw new PsycheError("unavailable", `plugin ${this.name}: ${(err as Error).message}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  call(method: string, params: unknown): Promise<unknown> {
    const child = this.#child;
    if (child?.stdin === null || child === undefined) {
      return Promise.reject(new Error(`plugin ${this.name} is not running`));
    }
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  stop(): void {
    this.#stopped = true;
    this.#child?.kill("SIGKILL");
    this.#child = undefined;
  }

  stderr(): string {
    return this.#stderr;
  }

  #reply(line: string): void {
    if (Buffer.byteLength(line) > MAX_REPLY_BYTES) return;
    let msg: { id?: unknown; result?: unknown; error?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.#pending.get(msg.id);
    if (p === undefined) return;
    this.#pending.delete(msg.id);
    if (msg.error !== undefined) p.reject(new Error(String(msg.error)));
    else p.resolve(msg.result);
  }
}

/** The loop's view of a running plugin: only the declared capabilities are wired. */
export function agentPlugin(
  host: PluginHost,
  capabilities: readonly PluginCapability[],
): AgentPlugin {
  const has = (c: PluginCapability) => capabilities.includes(c);
  return {
    name: host.name,
    capabilities: [...capabilities],
    ...(has("context")
      ? { context: async (run) => (await host.call("context", run)) as PluginSection[] | undefined }
      : {}),
    ...(has("before_tool_call")
      ? {
          beforeToolCall: async (c) =>
            (await host.call("before_tool_call", c)) as { block?: string } | undefined,
        }
      : {}),
    ...(has("after_tool_call")
      ? {
          afterToolCall: async (r) => {
            await host.call("after_tool_call", r);
          },
        }
      : {}),
    ...(has("agent_end")
      ? {
          agentEnd: async (e) => {
            await host.call("agent_end", e);
          },
        }
      : {}),
    ...(has("evaluate")
      ? {
          evaluate: async (i) =>
            (await host.call("evaluate", {
              taskId: i.taskId,
              goal: i.goal,
              // Receipts as the evaluator sees them: kind, outcome, summary, refs.
              receipts: i.receipts.map((r) => ({
                kind: r.kind,
                outcome: r.outcome,
                summary: r.summary,
                externalRefs: r.externalRefs,
              })),
            })) as PluginVerdict | undefined,
        }
      : {}),
  };
}
