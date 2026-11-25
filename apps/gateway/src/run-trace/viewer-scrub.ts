import type { PsycheDb } from "@psyche/db";
import { citeSourceOf } from "@psyche/proactive";
import type { RunStep } from "@psyche/protocol";
import { OWNER_ONLY_SOURCES, SEARCH_EVERYTHING_TOOL } from "@psyche/search";
import { isDesktopViewer } from "../compose/fork-hidden.ts";
import type { Call } from "../context.ts";
import type { Reader } from "../message-scrub.ts";

/**
 * The run trace as a viewer that is not the desktop shell sees it (`runs.get`, `runs.steps`,
 * `runs.step`, `runs.export` and the `run.step` event). Remote viewers (a paired phone, a remote
 * Mac, the web shell) may not open Messages, Contacts or Memory files, and only the desktop shell
 * sees quotes from those sources or from mail bodies. A step of a tool that reads or writes them
 * keeps its kind, status, ids and timing; its label, target, previews, payloads, progress text and
 * error text become a short placeholder. Every step drops its `memoryPath` (the names of people
 * and project files are Memory too). The desktop shell's view is unchanged.
 *
 * Who is the desktop shell: the call's `desktopShell` identity on a loopback peer
 * (`isDesktopViewer`, never a param), or a bus subscriber with `reader.local`.
 */

export type OwnerOnlySource = "messages" | "contacts" | "memory" | "mail" | "unknown";

/** Sources only the desktop shell reads: search's owner-only sources plus mail bodies. */
const OWNER_ONLY: ReadonlySet<string> = new Set<string>([...OWNER_ONLY_SOURCES, "mail"]);

/**
 * Agent-core builtins that read or write the Memory workspace by their own names (`memory`, the
 * Markdown memory tool; `remember`). Connector and recall tools are classified by
 * `citeSourceOf`, the fork read guard's rule, so both stay in step.
 */
const MEMORY_BUILTINS: ReadonlySet<string> = new Set(["memory", "remember"]);

const LABEL: Record<OwnerOnlySource, string> = {
  messages: "Messages",
  contacts: "Contacts",
  memory: "Memory",
  mail: "Mail",
  unknown: "a private source",
};

/** The placeholder a hidden step input or output becomes. */
export const hiddenText = (source: OwnerOnlySource): string =>
  `Read from ${LABEL[source]}: hidden on this device`;

/** The label a hidden step shows. */
export const hiddenLabel = (source: OwnerOnlySource): string => `Used ${LABEL[source]}`;

/**
 * A tool's bare name, folded: the part after a connector's `mcp__<server>__` prefix (whatever the
 * server id holds), NFKC and case folded so `Contacts_Search` and full-width spellings match.
 */
export function bareToolName(tool: string): string {
  const parts = tool.split("__");
  const bare = tool.startsWith("mcp__") && parts.length >= 3 ? parts.slice(2).join("__") : tool;
  return bare.normalize("NFKC").toLowerCase().toUpperCase().toLowerCase().normalize("NFKC");
}

/** Text that names an owner-only search document (`messages:…`, `contacts:…`, `memory:…`). */
const OWNER_DOC = new RegExp(`(?:${OWNER_ONLY_SOURCES.join("|")}):`, "i");

/**
 * The owner-only source a tool reads or writes, or `null` for an ordinary tool. `search_everything`
 * is ordinary unless what it returned names an owner-only document (the owner may let the agent
 * search Messages, Contacts or Memory); `content` is its output text when known.
 */
export function ownerOnlySourceOfTool(tool: string, content?: string): OwnerOnlySource | null {
  const bare = bareToolName(tool);
  if (MEMORY_BUILTINS.has(bare)) return "memory";
  if (bare === SEARCH_EVERYTHING_TOOL) {
    const m = content === undefined ? null : OWNER_DOC.exec(content);
    return m === null ? null : (m[0].slice(0, -1).toLowerCase() as OwnerOnlySource);
  }
  const source = citeSourceOf(bare);
  return source !== null && OWNER_ONLY.has(source) ? (source as OwnerOnlySource) : null;
}

/** Whether the call is the desktop shell on this Mac's loopback. */
export const fullViewOfCall = (call: Call): boolean => isDesktopViewer(call);

/** Whether a bus subscriber is the desktop shell on this Mac's loopback. */
export const fullViewOfReader = (reader: Reader): boolean => reader.local === true;

export interface StepClassifier {
  /** The tool a call ran, from the sink's memory or the store; `undefined` when unknown. */
  toolOf(toolCallId: string): string | undefined;
  /** A helper run's tool calls (its own steps), for a spawn step's output. */
  toolsOfRun(runId: string): readonly string[] | undefined;
}

/** The store's answers for {@link StepClassifier}. */
export function storeClassifier(
  db: PsycheDb,
  memory?: (toolCallId: string) => string | undefined,
): StepClassifier {
  return {
    toolOf(toolCallId) {
      const known = memory?.(toolCallId);
      if (known !== undefined) return known;
      try {
        const row = db.sqlite.prepare("SELECT tool FROM tool_calls WHERE id = ?").get(toolCallId) as
          | { tool: string }
          | undefined;
        return row?.tool;
      } catch {
        return undefined;
      }
    },
    toolsOfRun(runId) {
      try {
        return (
          db.sqlite.prepare("SELECT tool FROM tool_calls WHERE run_id = ?").all(runId) as {
            tool: string;
          }[]
        ).map((r) => r.tool);
      } catch {
        return undefined;
      }
    },
  };
}

/** Text to look for owner-only document ids in: the previews and any payloads given. */
const contentOf = (step: RunStep, payloads?: { input?: unknown; output?: unknown }): string => {
  const parts: string[] = [step.preview?.input ?? "", step.preview?.output ?? ""];
  for (const v of [payloads?.input, payloads?.output]) {
    if (v === undefined) continue;
    try {
      parts.push(typeof v === "string" ? v : JSON.stringify(v));
    } catch {
      parts.push("messages:");
    }
  }
  return parts.join("\n");
};

/**
 * Which owner-only source a step shows, or `null`. Fails closed: a tool step whose tool cannot be
 * read is `unknown`, and so is a helper's spawn step whose helper run's calls cannot be read.
 */
export function stepSource(
  step: RunStep,
  cls: StepClassifier,
  payloads?: { input?: unknown; output?: unknown },
  depth = 0,
): OwnerOnlySource | null {
  if (step.kind !== "tool" && step.kind !== "subagent") return null;
  if (step.toolCallId !== undefined) {
    const tool = cls.toolOf(step.toolCallId);
    if (tool === undefined) return "unknown";
    const own = ownerOnlySourceOfTool(tool, contentOf(step, payloads));
    if (own !== null) return own;
  } else if (step.kind === "tool") {
    return "unknown";
  }
  // A helper's result can quote what the helper read: its spawn step follows its run's calls.
  if (step.kind === "subagent" && step.childRunId !== undefined) {
    if (depth >= 3) return "unknown";
    const tools = cls.toolsOfRun(step.childRunId);
    if (tools === undefined) return "unknown";
    for (const t of tools) {
      // The helper's search results are not at hand here: its search counts as private.
      const own = bareToolName(t) === SEARCH_EVERYTHING_TOOL ? "unknown" : ownerOnlySourceOfTool(t);
      if (own !== null) return own;
    }
  }
  return null;
}

/** A step as a remote viewer sees it, given its source (from {@link stepSource}). */
export function scrubStep(step: RunStep, source: OwnerOnlySource | null): RunStep {
  const { memoryPath: _m, ...rest } = step;
  if (source === null) return rest;
  const { doneLabel: _d, target: _t, preview, progress, error, ...kept } = rest;
  const hidden = hiddenText(source);
  return {
    ...kept,
    label: hiddenLabel(source),
    ...(preview === undefined
      ? {}
      : {
          preview: {
            ...(preview.input === undefined ? {} : { input: hidden }),
            ...(preview.output === undefined ? {} : { output: hidden }),
          },
        }),
    ...(progress?.fraction === undefined ? {} : { progress: { fraction: progress.fraction } }),
    ...(error === undefined ? {} : { error: { ...error, message: hidden } }),
  };
}

const MODEL_INPUT_HIDDEN = "Model input: hidden on this device";

/**
 * A model step's payloads for a remote viewer. The input holds the system prompt (USER.md,
 * MEMORY.md, daily notes) and every tool result of the run: it is never sent. The output keeps the
 * reply text the chat already shows; an owner-only tool call's input becomes the placeholder.
 */
export function scrubModelPayloads(p: { input?: unknown; output?: unknown }): {
  input?: unknown;
  output?: unknown;
} {
  const out: { input?: unknown; output?: unknown } = {};
  if (p.input !== undefined) out.input = MODEL_INPUT_HIDDEN;
  if (p.output !== undefined) {
    const o = p.output as { toolCalls?: unknown } | null;
    if (o === null || typeof o !== "object" || Array.isArray(o)) {
      out.output = typeof p.output === "string" ? MODEL_INPUT_HIDDEN : p.output;
    } else {
      const calls = Array.isArray(o.toolCalls) ? o.toolCalls : undefined;
      out.output = {
        ...o,
        ...(calls === undefined
          ? {}
          : {
              toolCalls: calls.map((c: unknown) => {
                const name = (c as { name?: unknown } | null)?.name;
                const src = typeof name === "string" ? ownerOnlySourceOfTool(name) : "unknown";
                return src === null ? c : { ...(c as object), input: hiddenText(src) };
              }),
            }),
      };
    }
  }
  return out;
}

/** A step's payloads for a remote viewer, given its source. */
export function scrubPayloads(
  step: RunStep,
  source: OwnerOnlySource | null,
  p: { input?: unknown; output?: unknown },
): { input?: unknown; output?: unknown } {
  if (step.kind === "model") return scrubModelPayloads(p);
  if (source === null) return p;
  return {
    ...(p.input === undefined ? {} : { input: hiddenText(source) }),
    ...(p.output === undefined ? {} : { output: hiddenText(source) }),
  };
}

/** The `run.step` payload for one bus subscriber: unchanged for the desktop shell. */
export function personalizeRunStep(
  payload: { runId: string; step: RunStep },
  reader: Reader,
  cls: StepClassifier,
): { runId: string; step: RunStep } {
  if (fullViewOfReader(reader)) return payload;
  return { ...payload, step: scrubStep(payload.step, stepSource(payload.step, cls)) };
}
