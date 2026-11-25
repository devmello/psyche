import { FORK_FETCH_TOOL, FORK_SEARCH_TOOL } from "@psyche/agent-core";
import type { ForkCiteSource, StagingReadCall, StagingReads, TaintSource } from "@psyche/protocol";
import { type BranchCall, OWNER_ONLY_SOURCES, READ_CLASSES } from "./report-check.ts";

/**
 * A branch's read guard (docs/design/fork-a-plan-2026.md §3.2, §4.2). One per branch run:
 *
 * - **The fetch rule.** `web.fetch` runs only for a URL that a `web.search` result of the same
 *   branch returned, by exact match after canonicalisation. A model-built URL is refused, which
 *   closes the exfiltration path of a tainted branch writing Memory facts into a query string.
 *   URLs found inside fetched pages or any other tool result do not count: only the search
 *   provider's own result list does.
 * - **The record.** Every finished read is kept (bounded) as a `BranchCall`, which is what the
 *   report's cites are checked against. Another branch's calls never mix in: the guard belongs to
 *   one branch.
 */

const MAX_URLS = 400;
const MAX_CALLS = 300;
const MAX_RESULT_CHARS = 200_000;

/**
 * The comparison key of a URL: http(s) only, no credentials, scheme and host lower-cased, the
 * default port and a trailing dot on the host dropped, the fragment dropped. Path and query are
 * kept exactly (two different queries are two different URLs). `undefined` for anything else.
 */
export function canonicalUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4_096) return undefined;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  if (u.username !== "" || u.password !== "") return undefined;
  u.hash = "";
  const host = u.host.replace(/\.(?=:\d+$|$)/, "");
  return `${u.protocol}//${host}${u.pathname}${u.search}`;
}

/** The URLs a `web.search` output lists: `results[].url`, nothing else. */
export function searchResultUrls(output: unknown): string[] {
  if (typeof output !== "object" || output === null) return [];
  const results = (output as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const out: string[] = [];
  for (const r of results) {
    if (typeof r !== "object" || r === null) continue;
    const c = canonicalUrl((r as { url?: unknown }).url);
    if (c !== undefined) out.push(c);
  }
  return out;
}

/** The cite source a read tool maps to; `null` for a tool that backs no cite. */
export function citeSourceOf(tool: string): ForkCiteSource | null {
  const bare = tool.replace(/^mcp__[a-z0-9-]+__/, "");
  if (bare === "memory_recall" || bare === "entity_recall") return "memory";
  if (tool === FORK_SEARCH_TOOL || tool === FORK_FETCH_TOOL) return "web";
  if (bare.startsWith("calendar_")) return "calendar";
  if (bare.startsWith("mail_") || bare.startsWith("gmail_")) return "mail";
  if (bare.startsWith("contacts_")) return "contacts";
  if (bare.startsWith("messages_")) return "messages";
  return null;
}

const MAX_TAINT_SOURCES = 20;

export class BranchReads implements StagingReads {
  readonly #urls = new Set<string>();
  readonly #calls: BranchCall[] = [];
  readonly #taint: TaintSource[] = [];
  readonly #onTaint: ((sources: readonly TaintSource[]) => void) | undefined;
  readonly #outputLimit: (() => number | undefined) | undefined;
  readonly #beforeModel: ((inputTokens: number) => boolean) | undefined;
  readonly #onFinish: ((run: { taint: boolean; taintSources: TaintSource[] }) => void) | undefined;
  readonly #onOwnerOnly: (() => void) | undefined;
  #ownerOnlySeen = false;

  constructor(
    opts: {
      onTaint?: (sources: readonly TaintSource[]) => void;
      /** The first successful read of Memory, Messages or Contacts (the branch row's mark). */
      onOwnerOnly?: () => void;
      /** The money check before each model call (`StagingReads.beforeModelCall`). */
      beforeModel?: (inputTokens: number) => boolean;
      /** The output limit every call is sent with (`StagingReads.outputLimit`). */
      outputLimit?: () => number | undefined;
      /** The run's own taint as it ends (`StagingReads.finish`). */
      onFinish?: (run: { taint: boolean; taintSources: TaintSource[] }) => void;
    } = {},
  ) {
    this.#onTaint = opts.onTaint;
    this.#beforeModel = opts.beforeModel;
    this.#outputLimit = opts.outputLimit;
    this.#onFinish = opts.onFinish;
    this.#onOwnerOnly = opts.onOwnerOnly;
  }

  outputLimit(): number | undefined {
    return this.#outputLimit?.();
  }

  beforeModelCall(step: { inputTokens: number }): boolean {
    return this.#beforeModel === undefined ? true : this.#beforeModel(step.inputTokens);
  }

  finish(run: { taint: boolean; taintSources: TaintSource[] }): void {
    this.#onFinish?.(run);
  }

  allowFetch(url: unknown): boolean {
    const c = canonicalUrl(url);
    return c !== undefined && this.#urls.has(c);
  }

  observe(call: StagingReadCall): void {
    // The same rule as the report check's `readOwnerOnly`, recorded before anything else (the
    // call record below is bounded; this mark is not).
    const source = citeSourceOf(call.tool);
    if (
      !this.#ownerOnlySeen &&
      call.ok &&
      READ_CLASSES.has(call.sideEffect) &&
      source !== null &&
      OWNER_ONLY_SOURCES.has(source)
    ) {
      this.#ownerOnlySeen = true;
      this.#onOwnerOnly?.();
    }
    // A search that failed returned nothing a fetch may rely on.
    if (call.tool === FORK_SEARCH_TOOL && call.ok) {
      for (const u of searchResultUrls(call.output)) {
        if (this.#urls.size >= MAX_URLS) break;
        this.#urls.add(u);
      }
    }
    if (call.provenance === "untrusted" && this.#taint.length < MAX_TAINT_SOURCES) {
      // Mail and web reads taint the branch; the row carries it into the staged items and Take (§3.5).
      this.#taint.push({ sourceKind: call.tool, toolCallId: call.callId });
      this.#onTaint?.([...this.#taint]);
    }
    if (this.#calls.length >= MAX_CALLS) return;
    let result: string;
    try {
      result = JSON.stringify(call.output) ?? "";
    } catch {
      result = "";
    }
    this.#calls.push({
      callId: call.callId,
      ok: call.ok,
      sideEffect: call.sideEffect,
      source: citeSourceOf(call.tool),
      result: result.slice(0, MAX_RESULT_CHARS),
    });
  }

  /** Every read this branch's run made, for the report check. */
  calls(): readonly BranchCall[] {
    return this.#calls;
  }

  /** The URLs the branch's searches returned (tests). */
  urls(): ReadonlySet<string> {
    return this.#urls;
  }
}
