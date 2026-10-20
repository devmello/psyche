import type { HarnessPlugin, HarnessRunContext, HarnessRunResult } from "@psyche/agent-core";
import { classifyClaudeTool } from "./classify.ts";
import type { ClaudeTransport, GateRequest } from "./transport.ts";

/**
 * Claude Code as a coding harness (feature C10; architecture §4.3 "Harness plugins"). The
 * `claude` CLI runs headless (`-p`, stream-json in and out) where the transport puts it (the
 * Task's sandbox in psyched). Every tool call it wants to make first reaches Psyche through a
 * `PreToolUse` hook: the adapter classifies it (`classify.ts`), asks the loop's `gate` (the
 * Permission Broker, the same cards as a native call: `file_write` diffs, `exec` commands,
 * `git_push` once only), and allows or denies the hook. What is not explicitly allowed is denied
 * (`--permission-prompts none`). Finished calls are reported with `actionDone` so write+ actions
 * get receipts; the CLI's final result is the report, untrusted.
 */

export const CLAUDE_CODE_DEFAULT_MAX_TURNS = 40;
/** Characters of progress lines and of the report kept. */
const CAP = { progress: 200, report: 16_000 };

export interface ClaudeCodeOptions {
  transport: ClaudeTransport;
  /** `--model`, e.g. `sonnet`; absent uses the CLI's default. */
  model?: string;
  maxTurns?: number;
}

/** CLI arguments the adapter adds; the transport adds the hook settings and the stream flags. */
export function claudeArgs(options: Pick<ClaudeCodeOptions, "model" | "maxTurns">): string[] {
  return [
    "--max-turns",
    String(options.maxTurns ?? CLAUDE_CODE_DEFAULT_MAX_TURNS),
    ...(options.model === undefined ? [] : ["--model", options.model]),
  ];
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  errors?: string[];
  message?: { content?: unknown };
}

const oneLine = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

export class ClaudeCodeHarness implements HarnessPlugin {
  readonly id = "claude-code";
  readonly name = "Claude Code";
  readonly #o: ClaudeCodeOptions;

  constructor(options: ClaudeCodeOptions) {
    this.#o = options;
  }

  available(): Promise<boolean> {
    return this.#o.transport.available();
  }

  async run(ctx: HarnessRunContext): Promise<HarnessRunResult> {
    const session = await this.#o.transport.start({
      cwd: ctx.cwd,
      ...(ctx.run === undefined ? {} : { run: ctx.run }),
      args: claudeArgs(this.#o),
      signal: ctx.signal,
    });
    const onAbort = () => void session.kill();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const map = { container: session.containerCwd, host: ctx.cwd };
    // Allowed calls waiting for their result: by Claude's tool_use id, else in order per tool.
    const pendingById = new Map<string, string>();
    const pendingByTool = new Map<string, string[]>();
    const toolNames = new Map<string, string>();

    const gates = (async () => {
      for await (const g of session.gates)
        await this.#gate(ctx, g, map, pendingById, pendingByTool);
    })();

    ctx.progress("Claude Code started");
    session.send(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: ctx.brief },
        parent_tool_use_id: null,
      }),
    );
    session.endInput();

    let result: StreamEvent | undefined;
    let sessionId: string | undefined;
    for await (const line of session.lines) {
      let e: StreamEvent;
      try {
        e = JSON.parse(line) as StreamEvent;
      } catch {
        continue;
      }
      if (typeof e.session_id === "string") sessionId = e.session_id;
      if (e.type === "assistant") {
        for (const block of contentBlocks(e)) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
            ctx.progress(oneLine(block.text, CAP.progress));
          }
          if (
            block.type === "tool_use" &&
            typeof block.id === "string" &&
            typeof block.name === "string"
          ) {
            toolNames.set(block.id, block.name);
          }
        }
      } else if (e.type === "user") {
        for (const block of contentBlocks(e)) {
          if (block.type !== "tool_result") continue;
          const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
          if (id === undefined) continue;
          let actionId = pendingById.get(id);
          if (actionId !== undefined) pendingById.delete(id);
          else {
            // A hook without a tool_use id: the oldest allowed call of the same tool.
            const queue = pendingByTool.get(toolNames.get(id) ?? "");
            actionId = queue?.shift();
          }
          if (actionId === undefined) continue;
          await ctx.actionDone(actionId, block.is_error === true ? "failed" : "ok");
        }
      } else if (e.type === "result") {
        result = e;
      }
    }
    await gates.catch(() => undefined);
    const exit = await session.exited;
    ctx.signal.removeEventListener("abort", onAbort);
    // Calls allowed but never reported back: their outcome is unknown.
    for (const actionId of [...pendingById.values(), ...[...pendingByTool.values()].flat()]) {
      await ctx.actionDone(actionId, "uncertain", "Claude Code did not report this call's result");
    }
    if (ctx.signal.aborted) {
      return {
        report: "Cancelled.",
        outcome: "cancelled",
        ...(sessionId === undefined ? {} : { sessionId }),
      };
    }
    if (result === undefined) {
      return {
        report: `Claude Code ended without a result (exit ${exit.exitCode ?? "killed"}).`,
        outcome: "failed",
        ...(sessionId === undefined ? {} : { sessionId }),
      };
    }
    const ok = result.subtype === "success" && result.is_error !== true;
    const text = ok
      ? (result.result ?? "")
      : `Claude Code stopped: ${result.subtype ?? "error"}${result.errors?.length ? ` (${result.errors.join("; ")})` : ""}`;
    return {
      report: text.length > CAP.report ? `${text.slice(0, CAP.report)}…` : text,
      outcome: ok ? "completed" : "failed",
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }

  async #gate(
    ctx: HarnessRunContext,
    g: GateRequest,
    map: { container: string; host: string },
    pendingById: Map<string, string>,
    pendingByTool: Map<string, string[]>,
  ): Promise<void> {
    let decision: Awaited<ReturnType<HarnessRunContext["gate"]>>;
    try {
      decision = await ctx.gate(classifyClaudeTool(g.tool, g.input, map));
    } catch (err) {
      g.respond({
        allow: false,
        reason: `Psyche could not check this call: ${(err as Error).message}`,
      });
      return;
    }
    if (!decision.allowed) {
      g.respond({ allow: false, reason: `Psyche did not allow this: ${decision.reason}` });
      return;
    }
    if (g.toolUseId !== undefined) pendingById.set(g.toolUseId, decision.actionId);
    else pendingByTool.set(g.tool, [...(pendingByTool.get(g.tool) ?? []), decision.actionId]);
    g.respond({ allow: true });
  }
}

function contentBlocks(e: StreamEvent): Record<string, unknown>[] {
  const c = e.message?.content;
  return Array.isArray(c)
    ? (c.filter((b) => typeof b === "object" && b !== null) as Record<string, unknown>[])
    : [];
}

/**
 * Codex and pi (feature C10): not implemented. Each would adapt its own approval hook (Codex's
 * approval policy over its JSON-RPC app server, pi's `beforeToolCall`) to `gate` the way the
 * Claude Code adapter adapts `PreToolUse`. Registered as unavailable so `harness.delegate`
 * says so instead of pretending.
 */
export function stubHarness(id: "codex" | "pi", name: string): HarnessPlugin {
  return {
    id,
    name,
    available: async () => false,
    run: async () => ({ report: `${name} is not supported yet.`, outcome: "failed" }),
  };
}
