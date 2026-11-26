import type { SearchHit } from "@psyche/protocol";

/** What the palette lists under "Recent" when the field is empty: the results the owner opened. */
const KEY = "psyche.palette.recentHits";
export const RECENT_HITS_MAX = 4;

const isHit = (x: unknown): x is SearchHit =>
  typeof x === "object" &&
  x !== null &&
  typeof (x as SearchHit).id === "string" &&
  typeof (x as SearchHit).scope === "string" &&
  typeof (x as SearchHit).title === "string";

/** The recently opened results, newest first. Storage may be missing or blocked. */
export function recentHits(): SearchHit[] {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter(isHit) : [];
  } catch {
    return [];
  }
}

const same = (a: SearchHit, b: SearchHit) => a.scope === b.scope && a.id === b.id;

/** Remembers an opened result. Only what the row needs is kept, never the snippet's text. */
export function rememberHit(hit: SearchHit): void {
  if (hit.route == null) return;
  try {
    const slim: SearchHit = {
      scope: hit.scope,
      id: hit.id,
      title: hit.title,
      snippet: "",
      score: 0,
      threadId: hit.threadId,
      route: hit.route,
      ...(hit.kind === undefined ? {} : { kind: hit.kind }),
    };
    const next = [slim, ...recentHits().filter((h) => !same(h, hit))].slice(0, RECENT_HITS_MAX);
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // Remembering is a convenience.
  }
}
