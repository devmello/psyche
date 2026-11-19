import type { ModelPart, ModelRequest, ToolSpec } from "@psyche/protocol";
import type { ProviderConfig } from "./config.ts";

/**
 * Anthropic prompt caching is a prefix match over `tools → system → messages`: any byte that
 * changes invalidates every cache entry after it, and a signed thinking block is bound to the
 * same prefix. This module decides what Psyche keeps byte-stable and where the breakpoints go:
 *
 * - `system` goes as two blocks, the stable head (base prompt, persona, skills, tool guidance)
 *   and the volatile tail (daily notes, the compaction summary, per-turn context), split at
 *   `ModelRequest.systemStableLength`;
 * - with `deferLoading: true` (off by default until a live smoke test,
 *   `scripts/smoke-deferred-tools.ts`), tools loaded on demand are all sent with
 *   `defer_loading: true`, and a `load_tools` result names what it loaded with `tool_reference`
 *   blocks (the API's custom tool search). Deferred tools are outside the cached prefix, so a
 *   load no longer rewrites the whole cache. Off, a loaded tool is appended to `tools` as before;
 * - breakpoints: the last tool sent up front, the stable system block and the last message, so
 *   three of the API's four. The first two use `prefixCacheTtl` (1 hour by default) when the
 *   request has a stable head, the last one `cacheTtl`.
 */

/** Models with deferred tool loading (`defer_loading`, `tool_reference`): Claude 4.5 and later. */
const DEFER_LOADING =
  /^claude-(?:(?:opus|sonnet)-4-[5-9]|haiku-4-5|(?:opus|sonnet|haiku|fable|mythos)-(?:[5-9]|preview))/;

/** The tool that loads deferred tools (agent-core `deferred.ts`). */
const LOAD_TOOLS = "load_tools";

export interface ToolPlan {
  /** Tools sent up front, in request order: what a thinking block is bound to. */
  upFront: ToolSpec[];
  /** Tools sent with `defer_loading: true` (empty unless deferral is on). */
  deferred: ToolSpec[];
  /** Names a `load_tools` result may reference: the deferred tools sent. */
  referable: ReadonlySet<string>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The names a successful `load_tools` result loaded (or found loaded already), in order. */
function loadedBy(part: Extract<ModelPart, { type: "tool_result" }>): string[] {
  if (part.isError === true || !isRecord(part.output)) return [];
  const out: string[] = [];
  for (const key of ["loaded", "already"] as const) {
    const list = part.output[key];
    if (Array.isArray(list)) for (const n of list) if (typeof n === "string") out.push(n);
  }
  return out;
}

/** Psyche's name of the tool behind a result (the part's own, else its call's). */
function resultNames(
  request: ModelRequest,
): Map<Extract<ModelPart, { type: "tool_result" }>, string> {
  const byCall = new Map<string, string>();
  for (const m of request.messages)
    for (const p of m.parts) if (p.type === "tool_call") byCall.set(p.id, p.name);
  const out = new Map<Extract<ModelPart, { type: "tool_result" }>, string>();
  for (const m of request.messages)
    for (const p of m.parts) {
      if (p.type !== "tool_result") continue;
      const name = p.name ?? byCall.get(p.callId);
      if (name !== undefined) out.set(p, name);
    }
  return out;
}

/**
 * Whether this call sends `request.deferredTools` with `defer_loading` (Anthropic, Claude 4.5+,
 * `deferLoading: true`). Off by default: the request shape is checked against the docs and the
 * provider package only, and a shape the API rejected would fail every turn.
 */
export function defersTools(config: ProviderConfig, modelId: string): boolean {
  return config.kind === "anthropic" && config.deferLoading === true && DEFER_LOADING.test(modelId);
}

/**
 * Which tools go up front and which deferred. Without deferral (another provider, an older
 * model, nothing deferrable) it is `request.tools` as before. With it, every deferred tool is
 * sent with `defer_loading`; a loaded one stays deferred once a `load_tools` result in the
 * history references it. A loaded tool with no such result (loaded before this change, or by a
 * direct call that `#gate` loaded) goes up front as it did before, so the model keeps it.
 */
export function toolPlan(request: ModelRequest, config: ProviderConfig, modelId: string): ToolPlan {
  const tools = request.tools ?? [];
  const pool = request.deferredTools ?? [];
  const none: ToolPlan = { upFront: tools, deferred: [], referable: new Set() };
  if (pool.length === 0 || tools.length === 0 || !defersTools(config, modelId)) return none;
  const deferrable = new Set(pool.map((t) => t.name));
  const referenced = new Set<string>();
  for (const [part, name] of resultNames(request)) {
    if (name !== LOAD_TOOLS) continue;
    for (const n of loadedBy(part)) if (deferrable.has(n)) referenced.add(n);
  }
  const upFront = tools.filter((t) => !deferrable.has(t.name) || !referenced.has(t.name));
  // The API needs at least one tool that is not deferred (in practice tool_search, load_tools).
  if (upFront.length === 0) return none;
  const sent = new Set(upFront.map((t) => t.name));
  const deferred = pool.filter((t) => !sent.has(t.name));
  return { upFront, deferred, referable: new Set(deferred.map((t) => t.name)) };
}

/**
 * The deferred tools a `load_tools` result should name with `tool_reference` blocks: what it
 * loaded that is sent deferred. A name no longer sent (a connector removed since) is left out:
 * a reference to a tool missing from `tools` fails the whole request.
 */
export function toolReferences(
  part: Extract<ModelPart, { type: "tool_result" }>,
  name: string,
  plan: ToolPlan,
): string[] {
  if (name !== LOAD_TOOLS || plan.referable.size === 0) return [];
  return [...new Set(loadedBy(part))].filter((n) => plan.referable.has(n));
}

export type CacheTtl = "5m" | "1h";

/**
 * TTLs for the prefix breakpoints (tools, stable system) and the last message. A 1-hour entry
 * must come before any 5-minute one, so a 1-hour tail makes the prefix 1-hour too. The prefix
 * gets `prefixCacheTtl` only when the request marks a stable head: an unsplit system prompt may
 * change every call, and a 1-hour write there would cost twice for nothing.
 */
export function cacheTtls(
  request: ModelRequest,
  config: ProviderConfig,
): { prefix: CacheTtl; tail: CacheTtl } {
  const tail = config.cacheTtl ?? "5m";
  if (tail === "1h") return { prefix: "1h", tail };
  const prefix = request.systemStableLength === undefined ? tail : (config.prefixCacheTtl ?? "1h");
  return { prefix, tail };
}

/**
 * The system prompt as blocks for Anthropic: the stable head and the volatile tail, split at
 * `systemStableLength` (the blank line between them is the join, not part of either block).
 * One block when there is nothing to split.
 */
export function systemBlocks(request: ModelRequest, config: ProviderConfig): string[] {
  const system = request.system ?? "";
  if (system.length === 0) return [];
  const at = request.systemStableLength;
  if (config.kind !== "anthropic" || at === undefined || at <= 0 || at >= system.length) {
    return [system];
  }
  const head = system.slice(0, at);
  let tail = system.slice(at);
  if (tail.startsWith("\n\n")) tail = tail.slice(2);
  if (head.trim() === "" || tail.trim() === "") return [system];
  return [head, tail];
}
