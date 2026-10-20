import type {
  PermissionMode,
  PluginCapability,
  ProvenanceOut,
  Receipt,
  RunMode,
  SideEffect,
  ToolCallStatus,
  Unsubscribe,
} from "@psyche/protocol";
import type { EvaluationVerdict } from "./evaluator.ts";

/**
 * Code plugins (feature T4; architecture §13 "Plugins"). A plugin extends the harness through the
 * capabilities its manifest declares, and nothing else:
 *
 * - `context`: sections appended to the system prompt. Always untrusted (fenced and marked), and
 *   a run that receives any is tainted with `{sourceKind: "plugin", origin: <name>}`.
 * - `before_tool_call`: may block a call (with a reason the model sees), never allow one; the
 *   broker still decides everything it lets through.
 * - `after_tool_call`, `agent_end`: observe only (tool, status, provenance; outcome, steps); never
 *   the call's output, so a plugin cannot read what tools returned.
 * - `evaluate`: a task check after the built-in evaluator said done; it can only make the verdict
 *   stricter (`reopen` / `escalate`).
 *
 * Every call has a deadline. A plugin that throws or misses it blocks the call
 * (`before_tool_call`) or escalates the task (`evaluate`): fail closed. Context and observers are
 * skipped instead. The Gateway's host runs each plugin in its own permission-restricted process
 * (`@psyche/plugins`); this module only defines the seam the loop calls.
 */

export const PLUGIN_CALL_TIMEOUT_MS = 3_000;
/** Characters of one context section and of a block or evaluator reason. */
export const PLUGIN_TEXT_CAP = { section: 8_000, reason: 300, sections: 4 };

export interface PluginRunRef {
  threadId: string;
  runId: string;
  taskId?: string;
  permissionMode: PermissionMode;
  mode: RunMode;
  /** The run has read untrusted content. */
  taint: boolean;
}

export interface PluginSection {
  title: string;
  text: string;
}

export interface PluginToolCall extends PluginRunRef {
  toolCallId: string;
  tool: string;
  sideEffect: SideEffect;
  params: unknown;
}

export interface PluginToolResult extends PluginRunRef {
  toolCallId: string;
  tool: string;
  status: ToolCallStatus;
  provenance: ProvenanceOut;
}

export interface PluginRunEnd extends PluginRunRef {
  outcome: string;
  steps: number;
}

export interface PluginEvaluationInput {
  taskId: string;
  goal: string;
  receipts: readonly Receipt[];
}

export interface PluginVerdict {
  verdict: EvaluationVerdict;
  reason?: string;
  gaps?: string[];
}

export interface AgentPlugin {
  name: string;
  capabilities: readonly PluginCapability[];
  context?(run: PluginRunRef): Promise<PluginSection[] | undefined>;
  beforeToolCall?(call: PluginToolCall): Promise<{ block?: string } | undefined>;
  afterToolCall?(result: PluginToolResult): Promise<void>;
  agentEnd?(end: PluginRunEnd): Promise<void>;
  evaluate?(input: PluginEvaluationInput): Promise<PluginVerdict | undefined>;
}

/** The plugins the loop consults; the Gateway adds and removes them as the owner switches. */
export class AgentPluginRegistry {
  readonly #plugins = new Map<string, AgentPlugin>();

  register(plugin: AgentPlugin): Unsubscribe {
    this.#plugins.set(plugin.name, plugin);
    return () => {
      if (this.#plugins.get(plugin.name) === plugin) this.#plugins.delete(plugin.name);
    };
  }

  list(): AgentPlugin[] {
    return [...this.#plugins.values()];
  }

  /** Plugins that declared `capability` and implement it. */
  with<K extends keyof AgentPlugin>(capability: PluginCapability, method: K): AgentPlugin[] {
    return this.list().filter(
      (p) => p.capabilities.includes(capability) && typeof p[method] === "function",
    );
  }
}

/** Resolves with the call's value, or rejects after `ms` (the plugin missed its deadline). */
export async function withDeadline<T>(
  name: string,
  work: Promise<T>,
  ms = PLUGIN_CALL_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`plugin ${name} did not answer in ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Plugin text shown to the model or the owner: one line, capped. */
export function pluginText(text: unknown, cap: number): string {
  const s = typeof text === "string" ? text : "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const flat = s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}
