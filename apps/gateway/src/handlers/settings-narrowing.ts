import { canonicalPath, compilePolicy } from "@psyche/permissions";
import {
  BROWSER_DEV_PREVIEW_PORTS_KEY,
  BROWSER_PARTITION_KEY,
  BROWSER_PARTITION_WIDTH,
  BROWSER_SIGNED_IN_ORIGINS_KEY,
  DEFAULT_BROWSER_PARTITION,
  parseBrowserPartition,
} from "@psyche/protocol";

/**
 * Which security-setting changes may skip the approval card: only those that PROVABLY narrow what
 * the agent may do (docs/05-security-and-permissions.md §3.7). It fails closed: a key it does not
 * know, a value of the wrong shape, a stored value it cannot read, a removal that falls back to
 * an unknown default, or one widened field in an otherwise narrowing change, all give `false`
 * and the change raises its card as before.
 *
 * Pure: no database and no caller. `settings.set` additionally requires `operator.admin` and
 * keeps the seal and the audit row.
 */

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrArray = (v: Json): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Key order is kept on purpose: some readers take the FIRST matching entry (`sites`, `apps`), so
 * a reordered record is a change, never "the same" (review #1354 r2 B2).
 */
function canon(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "undefined";
}
const same = (a: Json, b: Json) => canon(a) === canon(b);

/** `next` is a subset of `stored` (nothing was added). Strings only. */
function noneAdded(stored: Json, next: Json): boolean {
  if (!isStrArray(stored) || !isStrArray(next)) return false;
  const have = new Set(stored);
  return next.every((x) => have.has(x));
}
/** `next` is a superset of `stored` (nothing was dropped). Strings only. */
function noneDropped(stored: Json, next: Json): boolean {
  return noneAdded(next, stored);
}

/** `next` is a subset of `stored`, for lists of strings or numbers. Anything else is false. */
function subsetOf(stored: Json, next: Json): boolean {
  if (!Array.isArray(stored) || !Array.isArray(next)) return false;
  const have = new Set<unknown>(stored);
  return next.every((x) => have.has(x));
}

const RULE_RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const TIER_RANK: Record<string, number> = { off: 0, read: 1, click: 2, interact: 3 };
/** The same tiers, highest = strictest (for `recordStricter`). */
const TIER_STRICTNESS: Record<string, number> = { interact: 0, click: 1, read: 2, off: 3 };
const FOLDER_RANK: Record<string, number> = { ro: 0, rw: 1 };

/**
 * A record of `name -> level` where a higher rank is stricter. Every stored name must stay, at
 * the same or a stricter level (dropping one falls back to a default we do not know here). A new
 * name is accepted only at the strictest level. Some readers use the FIRST matching entry
 * (`sites`, `apps`), so with `ordered` the stored names must keep their relative order, and with
 * `foldCase` two names that differ only in case (one matches the other) are refused.
 */
function recordStricter(
  stored: Json,
  next: Json,
  rank: Record<string, number>,
  strictest: string,
  opts: { ordered?: boolean; foldCase?: boolean } = {},
): boolean {
  const s = stored === undefined ? {} : stored;
  if (!isObj(s) || !isObj(next)) return false;
  for (const [k, v] of Object.entries(s)) {
    const was = typeof v === "string" ? rank[v] : undefined;
    const kept = Object.hasOwn(next, k) ? next[k] : undefined;
    const now = typeof kept === "string" ? rank[kept] : undefined;
    if (was === undefined || now === undefined || now < was) return false;
  }
  for (const [k, v] of Object.entries(next)) {
    if (Object.hasOwn(s, k)) continue;
    if (v !== strictest) return false;
  }
  if (opts.foldCase) {
    for (const o of [s, next]) {
      const keys = Object.keys(o).map((k) => k.toLowerCase());
      if (new Set(keys).size !== keys.length) return false;
    }
  }
  if (opts.ordered) {
    const kept = Object.keys(next).filter((k) => Object.hasOwn(s, k));
    if (canon(kept) !== canon(Object.keys(s))) return false;
  }
  return true;
}

/**
 * Folders. The engine resolves a path by the LONGEST root, in canonical form, and a stable sort
 * lets the first entry win a tie. So compare canonical paths (a duplicate is refused), keep the
 * stored order, never raise a mode, and when a read-only entry is removed no remaining ancestor
 * may be read-write (the subtree would open up).
 */
function foldersNarrower(stored: Json, next: Json): boolean {
  const s = stored === undefined ? [] : stored;
  if (!Array.isArray(s) || !Array.isArray(next)) return false;
  const read = (rows: Json[]): { path: string; mode: number }[] | null => {
    const out: { path: string; mode: number }[] = [];
    const seen = new Set<string>();
    for (const f of rows) {
      if (!isObj(f) || typeof f.path !== "string" || typeof f.mode !== "string") return null;
      const mode = FOLDER_RANK[f.mode];
      const path = canonicalPath(f.path);
      if (mode === undefined || seen.has(path)) return null;
      seen.add(path);
      out.push({ path, mode });
    }
    return out;
  };
  const was = read(s);
  const now = read(next);
  if (was === null || now === null) return false;
  const index = new Map(was.map((f, i) => [f.path, i]));
  let last = -1;
  for (const f of now) {
    const i = index.get(f.path);
    if (i === undefined || i < last) return false;
    last = i;
    const before = was[i];
    if (before === undefined || f.mode > before.mode) return false;
  }
  // Removing a read-only entry always raises the card: the subtree falls to whatever else covers
  // it, and that includes this conversation's own folder grants, which this pure check cannot see
  // (review #1354 r2 B3). Removing a read-write entry only ever narrows.
  const remaining = new Set(now.map((f) => f.path));
  for (const r of was) {
    if (!remaining.has(r.path) && r.mode === FOLDER_RANK.ro) return false;
  }
  return true;
}

/** `exec`: host exec off, read-only commands asking, fewer env names. Other keys stay equal. */
function execNarrower(stored: Json, next: Json): boolean {
  const s = stored === undefined ? {} : stored;
  const n = next === undefined ? {} : next;
  if (!isObj(s) || !isObj(n)) return false;
  for (const k of new Set([...Object.keys(s), ...Object.keys(n)])) {
    if (same(s[k], n[k])) continue;
    if (k === "execHostEnabled") {
      // On only for exactly `true`; anything else is off.
      if (n[k] !== undefined && typeof n[k] !== "boolean") return false;
      if (n[k] === true && s[k] !== true) return false;
    } else if (k === "readOnlyWithoutAsking") {
      // On unless exactly `false`.
      if (n[k] !== undefined && typeof n[k] !== "boolean") return false;
      if (n[k] !== false && s[k] === false) return false;
    } else if (k === "allowEnv") {
      if (!noneAdded(s[k] ?? [], n[k] ?? [])) return false;
    } else return false;
  }
  return true;
}

// Only fields that take effect as written. `connectors` (a rule equal to the catalogue default is
// dropped, exposing the layer under it), `liftedFloors` and `sensitiveCategories` (`hostPolicy`
// replaces them with their own settings), `ask`, `designated` and the rest card unless unchanged.
const POLICY_FIELDS: Record<string, (stored: Json, next: Json) => boolean> = {
  // Fewer allow rules, more deny rules.
  allow: (s, n) => noneAdded(s ?? [], n ?? []),
  deny: (s, n) => noneDropped(s ?? [], n),
  apps: (s, n) => recordStricter(s, n, TIER_STRICTNESS, "off", { ordered: true, foldCase: true }),
  sites: (s, n) => recordStricter(s, n, RULE_RANK, "deny", { ordered: true }),
  folders: foldersNarrower,
  workspaceRoots: (s, n) => noneAdded(s ?? [], n ?? []),
  // More sensitive origins; the list replaces a bundled default, so it must exist already.
  sensitiveOrigins: (s, n) => s !== undefined && noneDropped(s, n),
  exec: execNarrower,
};

function policyNarrower(stored: Json, next: Json): boolean {
  const s = stored === undefined ? {} : stored;
  if (!isObj(s) || !isObj(next)) return false;
  try {
    // What the live broker validates with: an invalid stored policy falls back to the default.
    compilePolicy(s as never);
    compilePolicy(next as never);
  } catch {
    return false;
  }
  for (const k of new Set([...Object.keys(s), ...Object.keys(next)])) {
    if (same(s[k], next[k])) continue;
    const check = POLICY_FIELDS[k];
    if (check === undefined || !check(s[k], next[k])) return false;
  }
  return true;
}

/**
 * `computerUse.apps`: `[{id, name, tier}]`. Tiers only go down (`ask` rows are what `noteApp`
 * writes; the reader drops them, so they are inert: an `ask` row may stay or go, and nothing
 * moves to or from `ask` except to `off`). Ids are unique ignoring case, kept rows keep their
 * order, a new row is accepted only at `off`.
 */
function computerAppsNarrower(stored: Json, next: Json): boolean {
  const s = stored === undefined ? [] : stored;
  if (!Array.isArray(s) || !Array.isArray(next)) return false;
  type Row = { id: string; tier: string };
  const read = (rows: Json[]): Row[] | null => {
    const out: Row[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (!isObj(r) || typeof r.id !== "string" || typeof r.tier !== "string") return null;
      if (r.tier !== "ask" && TIER_RANK[r.tier] === undefined) return null;
      const lower = r.id.toLowerCase();
      if (seen.has(lower)) return null;
      seen.add(lower);
      out.push({ id: r.id, tier: r.tier });
    }
    return out;
  };
  const was = read(s);
  const now = read(next);
  if (was === null || now === null) return false;
  const before = new Map(was.map((r) => [r.id, r.tier]));
  const after = new Map(now.map((r) => [r.id, r.tier]));
  for (const [id, tier] of before) {
    const n = after.get(id);
    if (n === undefined) {
      if (tier === "ask") continue;
      return false;
    }
    if (n === tier || n === "off") continue;
    if (tier === "ask" || n === "ask") return false;
    if ((TIER_RANK[n] ?? 99) > (TIER_RANK[tier] ?? -1)) return false;
  }
  for (const [id, tier] of after) if (!before.has(id) && tier !== "off") return false;
  const kept = now.filter((r) => before.has(r.id)).map((r) => r.id);
  return canon(kept) === canon(was.filter((r) => after.has(r.id)).map((r) => r.id));
}

/** True only when the change from `stored` to `next` provably narrows. Unknown means false. */
export function isNarrowing(key: string, stored: unknown, next: unknown): boolean {
  try {
    // Writing the same value again narrows nothing: it keeps its card, as before (and an
    // approved card stays single-use).
    if (same(stored, next)) return false;
    // The stored policy must exist: without it the baseline may be the config file's.
    if (key === "permissions.policy") return stored !== undefined && policyNarrower(stored, next);
    if (key === "computerUse.enabled") {
      // Off unless exactly `true`.
      return next === false && (stored === undefined || typeof stored === "boolean");
    }
    if (key === "computerUse.apps") return computerAppsNarrower(stored, next);
    if (/^permissions\.liftedFloors\.[^.]+$/.test(key)) {
      return noneAdded(stored ?? [], next);
    }
    // Agent browser (Settings → Browser). Mode: a narrower mode (or the same one) narrows; the
    // default is `auto` until one is stored. Signed-in sites and dev-preview ports: a removal only.
    if (key === BROWSER_PARTITION_KEY) {
      const was = parseBrowserPartition(stored ?? DEFAULT_BROWSER_PARTITION);
      const now = parseBrowserPartition(next);
      return (
        was !== undefined &&
        now !== undefined &&
        BROWSER_PARTITION_WIDTH[now] <= BROWSER_PARTITION_WIDTH[was]
      );
    }
    if (key === BROWSER_SIGNED_IN_ORIGINS_KEY || key === BROWSER_DEV_PREVIEW_PORTS_KEY) {
      return subsetOf(stored ?? [], next);
    }
    // Connector matrices (a rule equal to its catalogue default is dropped, which exposes the layer
    // under it), channel keys (nothing reads them), devices, vault, gateway, identityLinks,
    // exec.* keys (a binary path) and anything unknown.
    return false;
  } catch {
    return false;
  }
}
