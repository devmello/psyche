/**
 * Prefix-stability checks on Anthropic Messages request bodies, as the provider package sends
 * them (captured with `replayFetch`). Prompt caching is a prefix match over
 * `tools → system → messages`: a byte that changes before a breakpoint misses the cache for
 * every breakpoint after it, and rebinds earlier thinking. These helpers flatten a body into
 * that render order and compare the exact bytes of each position.
 *
 * - `cache_control` is stripped before comparing: moving the marker is how caching works.
 * - Tools with `defer_loading: true` are not positions: the API keeps them out of the prefix
 *   until a `tool_reference` loads them (and a referenced definition does not change).
 * - A message's role is part of each of its positions.
 */

type Json = Record<string, unknown>;

export interface AnthropicBody {
  tools?: Json[];
  system?: string | Json[];
  messages: { role: string; content: string | Json[] }[];
}

export type CacheTtl = "5m" | "1h";

export interface Position {
  /** `tools[2]`, `system[0]`, `messages[3][1]`. */
  path: string;
  /** Exact JSON of the block without `cache_control`. */
  bytes: string;
  /** The block's breakpoint, when it carries one. */
  breakpoint?: CacheTtl;
}

function ttlOf(block: Json): CacheTtl | undefined {
  const cc = block.cache_control as { type?: string; ttl?: string } | undefined;
  if (cc === undefined || cc === null) return undefined;
  return cc.ttl === "1h" ? "1h" : "5m";
}

function bytesOf(value: Json, extra: Json = {}): string {
  const { cache_control: _cc, ...rest } = value;
  return JSON.stringify({ ...extra, ...rest });
}

/** The body's positions in render order. */
export function positions(body: AnthropicBody): Position[] {
  const out: Position[] = [];
  const push = (path: string, block: Json, extra?: Json) => {
    const ttl = ttlOf(block);
    out.push({
      path,
      bytes: bytesOf(block, extra),
      ...(ttl === undefined ? {} : { breakpoint: ttl }),
    });
  };
  (body.tools ?? []).forEach((t, i) => {
    if (t.defer_loading !== true) push(`tools[${i}]`, t);
  });
  const system = body.system;
  if (typeof system === "string") push("system[0]", { type: "text", text: system });
  else
    (system ?? []).forEach((b, i) => {
      push(`system[${i}]`, b);
    });
  body.messages.forEach((m, i) => {
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    content.forEach((b, j) => {
      push(`messages[${i}][${j}]`, b, { role: m.role });
    });
  });
  return out;
}

/** Every breakpoint in render order, deferred tools included (a marker there is a 400). */
export function breakpoints(body: AnthropicBody): { path: string; ttl: CacheTtl }[] {
  const out: { path: string; ttl: CacheTtl }[] = [];
  (body.tools ?? []).forEach((t, i) => {
    const ttl = ttlOf(t);
    if (ttl !== undefined) out.push({ path: `tools[${i}]`, ttl });
  });
  for (const p of positions(body)) {
    if (p.breakpoint !== undefined && !p.path.startsWith("tools["))
      out.push({ path: p.path, ttl: p.breakpoint });
  }
  return out;
}

/**
 * Problems the API rejects or that silently lose caching: more than 4 breakpoints, a 1-hour
 * breakpoint after a 5-minute one, a breakpoint on a deferred tool, or every tool deferred.
 */
export function breakpointProblems(body: AnthropicBody): string[] {
  const problems: string[] = [];
  const all = breakpoints(body);
  if (all.length > 4) problems.push(`${all.length} breakpoints (the API allows 4)`);
  let seen5m = false;
  for (const b of all) {
    if (b.ttl === "5m") seen5m = true;
    else if (seen5m) problems.push(`1h breakpoint at ${b.path} after a 5m one`);
  }
  (body.tools ?? []).forEach((t, i) => {
    if (t.defer_loading === true && t.cache_control !== undefined)
      problems.push(`deferred tools[${i}] carries cache_control`);
  });
  const tools = body.tools ?? [];
  if (tools.length > 0 && tools.every((t) => t.defer_loading === true))
    problems.push("every tool is deferred");
  return problems;
}

export interface PrefixDiff {
  /** Index of the first differing position. */
  at: number;
  prev?: Position;
  next?: Position;
}

/**
 * Compares `next` with `prev` up to and including `prev`'s breakpoint number `through`
 * (0-based, render order; default its last), ignoring deferred tools. `undefined` means `next`
 * reads that cache entry; otherwise the first position that differs.
 */
export function prefixDiff(
  prev: AnthropicBody,
  next: AnthropicBody,
  through?: number,
): PrefixDiff | undefined {
  const a = positions(prev);
  const b = positions(next);
  const marks = a.flatMap((p, i) => (p.breakpoint === undefined ? [] : [i]));
  if (marks.length === 0) throw new Error("prefixDiff: the earlier body has no breakpoint");
  const end = marks[through ?? marks.length - 1];
  if (end === undefined) throw new Error(`prefixDiff: no breakpoint #${through}`);
  for (let i = 0; i <= end; i += 1) {
    if (a[i]?.bytes !== b[i]?.bytes) {
      const pa = a[i];
      const pb = b[i];
      return {
        at: i,
        ...(pa === undefined ? {} : { prev: pa }),
        ...(pb === undefined ? {} : { next: pb }),
      };
    }
  }
  return undefined;
}

/** Throws, naming the first differing position, unless `next` keeps `prev`'s cached prefix. */
export function assertPrefixStable(
  prev: AnthropicBody,
  next: AnthropicBody,
  through?: number,
): void {
  const diff = prefixDiff(prev, next, through);
  if (diff === undefined) return;
  const show = (p?: Position) =>
    p === undefined ? "(missing)" : `${p.path} ${p.bytes.slice(0, 240)}`;
  throw new Error(
    `prefix changed at position ${diff.at}:\n  before: ${show(diff.prev)}\n  after:  ${show(diff.next)}`,
  );
}
