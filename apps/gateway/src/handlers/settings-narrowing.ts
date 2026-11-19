import { parsePolicy } from "@psyche/permissions";

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

function canon(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .sort()
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

const RULE_RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const TIER_RANK: Record<string, number> = { off: 0, read: 1, click: 2, interact: 3 };
/** The same tiers, highest = strictest (for `recordStricter`). */
const TIER_STRICTNESS: Record<string, number> = { interact: 0, click: 1, read: 2, off: 3 };
const FOLDER_RANK: Record<string, number> = { ro: 0, rw: 1 };
const DM_STRICTNESS: Record<string, number> = { open: 0, pairing: 1, allowlist: 2, disabled: 3 };

/**
 * A record of `name -> level` where a higher rank is stricter. Every stored name must stay, at
 * the same or a stricter level (dropping one falls back to a default we do not know here). A new
 * name is accepted only at the strictest level.
 */
function recordStricter(
  stored: Json,
  next: Json,
  rank: Record<string, number>,
  strictest: string,
): boolean {
  const s = stored === undefined ? {} : stored;
  if (!isObj(s) || !isObj(next)) return false;
  for (const [k, v] of Object.entries(s)) {
    const was = typeof v === "string" ? rank[v] : undefined;
    const now = typeof next[k] === "string" ? rank[next[k] as string] : undefined;
    if (was === undefined || now === undefined || now < was) return false;
  }
  for (const [k, v] of Object.entries(next)) {
    if (k in s) continue;
    if (v !== strictest) return false;
  }
  return true;
}

/** A listed folder may stay or lose access; one not listed before is a widening. */
function foldersNarrower(stored: Json, next: Json): boolean {
  const s = stored === undefined ? [] : stored;
  if (!Array.isArray(s) || !Array.isArray(next)) return false;
  const lowest = new Map<string, number>();
  for (const f of s) {
    if (!isObj(f) || typeof f.path !== "string" || typeof f.mode !== "string") return false;
    const r = FOLDER_RANK[f.mode];
    if (r === undefined) return false;
    lowest.set(f.path, Math.min(lowest.get(f.path) ?? r, r));
  }
  for (const f of next) {
    if (!isObj(f) || typeof f.path !== "string" || typeof f.mode !== "string") return false;
    const r = FOLDER_RANK[f.mode];
    const was = lowest.get(f.path);
    if (r === undefined || was === undefined || r > was) return false;
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

/** `sensitiveCategories`: a category is on unless `false`; turning one off widens. */
function categoriesNarrower(stored: Json, next: Json): boolean {
  const s = stored === undefined ? {} : stored;
  const n = next === undefined ? {} : next;
  if (!isObj(s) || !isObj(n)) return false;
  for (const k of new Set([...Object.keys(s), ...Object.keys(n)])) {
    if (k !== "government" && k !== "icloud") return false;
    if (s[k] !== undefined && typeof s[k] !== "boolean") return false;
    if (n[k] !== undefined && typeof n[k] !== "boolean") return false;
    if (n[k] === false && s[k] !== false) return false;
  }
  return true;
}

/** `connectors` (per connector, per action): every cell moves toward deny. */
function connectorsStricter(stored: Json, next: Json): boolean {
  const s = stored === undefined ? {} : stored;
  if (!isObj(s) || !isObj(next)) return false;
  for (const [id, m] of Object.entries(s)) {
    if (!recordStricter(m, next[id], RULE_RANK, "deny")) return false;
  }
  for (const [id, m] of Object.entries(next)) {
    if (id in s) continue;
    if (!recordStricter({}, m, RULE_RANK, "deny")) return false;
  }
  return true;
}

/** `liftedFloors`: fewer lifted actions per connector. */
function liftedNarrower(stored: Json, next: Json): boolean {
  const s = stored === undefined ? {} : stored;
  if (!isObj(s) || !isObj(next)) return false;
  for (const [id, actions] of Object.entries(next)) {
    if (!noneAdded(s[id] ?? [], actions)) return false;
  }
  return Object.values(s).every(isStrArray);
}

const POLICY_FIELDS: Record<string, (stored: Json, next: Json) => boolean> = {
  // Fewer allow rules, more deny rules. (`ask` and `designated` only when unchanged.)
  allow: (s, n) => noneAdded(s ?? [], n ?? []),
  deny: (s, n) => noneDropped(s ?? [], n),
  connectors: connectorsStricter,
  liftedFloors: liftedNarrower,
  apps: (s, n) => recordStricter(s, n, TIER_STRICTNESS, "off"),
  sites: (s, n) => recordStricter(s, n, RULE_RANK, "deny"),
  folders: foldersNarrower,
  workspaceRoots: (s, n) => noneAdded(s ?? [], n ?? []),
  // More sensitive origins; the list replaces a bundled default, so it must exist already.
  sensitiveOrigins: (s, n) => s !== undefined && noneDropped(s, n),
  sensitiveCategories: categoriesNarrower,
  exec: execNarrower,
};

function policyNarrower(stored: Json, next: Json): boolean {
  const s = stored === undefined ? {} : stored;
  if (!isObj(s) || !isObj(next)) return false;
  try {
    parsePolicy(s);
    parsePolicy(next);
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

/** `computerUse.apps`: `[{id, name, tier}]`; tiers only go down, no row is dropped or added above off. */
function computerAppsNarrower(stored: Json, next: Json): boolean {
  const s = stored === undefined ? [] : stored;
  if (!Array.isArray(s) || !Array.isArray(next)) return false;
  const read = (rows: Json[]): Map<string, number> | null => {
    const out = new Map<string, number>();
    for (const r of rows) {
      if (!isObj(r) || typeof r.id !== "string" || typeof r.tier !== "string") return null;
      const tier = TIER_RANK[r.tier];
      if (tier === undefined || out.has(r.id)) return null;
      out.set(r.id, tier);
    }
    return out;
  };
  const was = read(s);
  const now = read(next);
  if (was === null || now === null) return false;
  for (const [id, tier] of was) {
    const n = now.get(id);
    if (n === undefined || n > tier) return false;
  }
  for (const [id, tier] of now) if (!was.has(id) && tier !== 0) return false;
  return true;
}

/** True only when the change from `stored` to `next` provably narrows. Unknown means false. */
export function isNarrowing(key: string, stored: unknown, next: unknown): boolean {
  try {
    // Writing the same value again narrows nothing: it keeps its card, as before (and an
    // approved card stays single-use).
    if (same(stored, next)) return false;
    if (key === "permissions.policy") return policyNarrower(stored, next);
    if (key === "computerUse.enabled") {
      // Off unless exactly `true`.
      return next === false && (stored === undefined || typeof stored === "boolean");
    }
    if (key === "computerUse.apps") return computerAppsNarrower(stored, next);
    if (/^permissions\.connectors\.[^.]+$/.test(key)) {
      return recordStricter(stored, next, RULE_RANK, "deny");
    }
    if (/^permissions\.liftedFloors\.[^.]+$/.test(key)) {
      return noneAdded(stored ?? [], next);
    }
    if (/^channels\.[^.]+\.allowFrom$/.test(key)) {
      // The stored list must exist: the channel row may hold something else.
      return stored !== undefined && noneAdded(stored, next);
    }
    if (/^channels\.[^.]+\.groupAllowFrom$/.test(key)) {
      // An empty group list falls back to `allowFrom`, which may be wider: it must stay filled.
      return (
        isStrArray(stored) &&
        stored.length > 0 &&
        isStrArray(next) &&
        next.length > 0 &&
        noneAdded(stored, next)
      );
    }
    if (/^channels\.[^.]+\.dmPolicy$/.test(key)) {
      const was = typeof stored === "string" ? DM_STRICTNESS[stored] : undefined;
      const now = typeof next === "string" ? DM_STRICTNESS[next] : undefined;
      return was !== undefined && now !== undefined && now >= was;
    }
    // devices, vault, gateway, identityLinks, exec.* keys (a binary path), anything unknown.
    return false;
  } catch {
    return false;
  }
}
