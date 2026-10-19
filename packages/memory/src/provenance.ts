import type { Provenance } from "@psyche/protocol";

/**
 * Provenance classes (architecture §4.8, security §8). `untrusted` and `system` content is never
 * promoted; unknown provenance is never `owner`. When content of several classes is combined,
 * the least trusted one wins.
 */

const RANK: Record<Provenance, number> = { untrusted: 0, system: 1, agent: 2, owner: 3 };

export const PROVENANCES: readonly Provenance[] = ["owner", "agent", "untrusted", "system"];

export function isProvenance(value: unknown): value is Provenance {
  return typeof value === "string" && Object.hasOwn(RANK, value);
}

export function trustRank(p: Provenance): number {
  return RANK[p];
}

/** The less trusted of two classes. */
export function leastTrusted(a: Provenance, b: Provenance): Provenance {
  return RANK[a] <= RANK[b] ? a : b;
}

/** True when content of class `p` must never become an owner fact. */
export function neverPromoted(p: Provenance): boolean {
  return p === "untrusted" || p === "system";
}

/** Where untrusted content came from, rendered in the daily-note tag. */
export interface ProvenanceOrigin {
  /** e.g. `email`, `web`, `message`, `mcp`. */
  kind: string;
  /** e.g. `alice@example.com`, `https://example.com`. */
  source?: string;
}

export interface ProvenanceTag {
  provenance: Provenance;
  origin?: ProvenanceOrigin;
}

/** Tag-safe text: no brackets, colons only inside `source`, no whitespace runs or newlines. */
function clean(text: string, max: number): string {
  return text
    .replace(/[[\]\r\n\t]/g, " ")
    .replace(/\s+/g, "_")
    .slice(0, max);
}

/** `owner`, `agent`, `system`, `untrusted` or `untrusted:<kind>:<source>` (data model §7.1). */
export function formatTag(tag: ProvenanceTag): string {
  if (tag.provenance !== "untrusted" || tag.origin === undefined) return tag.provenance;
  const kind = clean(tag.origin.kind, 32).replace(/:/g, "-").toLowerCase();
  if (kind.length === 0) return "untrusted";
  const source = tag.origin.source === undefined ? "" : clean(tag.origin.source, 200);
  return source.length > 0 ? `untrusted:${kind}:${source}` : `untrusted:${kind}`;
}

/** Parses the text between the brackets of a daily-note tag; `undefined` if it is not a tag. */
export function parseTag(raw: string): ProvenanceTag | undefined {
  const [head, kind, ...rest] = raw.split(":");
  if (head === undefined || !isProvenance(head)) return undefined;
  if (head !== "untrusted") return kind === undefined ? { provenance: head } : undefined;
  if (kind === undefined || kind.length === 0) return { provenance: "untrusted" };
  const source = rest.join(":");
  return {
    provenance: "untrusted",
    origin: source.length > 0 ? { kind, source } : { kind },
  };
}
