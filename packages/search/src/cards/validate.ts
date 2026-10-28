import type {
  CardClaim,
  CardSource,
  CardWhat,
  CardWhen,
  CardWhere,
  CardWho,
  ContextCard,
  DroppedClaim,
  WhatKind,
  WhereKind,
  WhoKind,
} from "./types.ts";
import { CARD_VERSION } from "./types.ts";

/** Longest quote kept: enough to cite a passage, short enough to stay a quote. */
const MAX_QUOTE = 400;
const MAX_ITEMS = 12;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function fold(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds `quote` in `source`: exact first, then ignoring case and whitespace differences.
 * Returns `[start, end)` into `source`, or `undefined` when the text is not there.
 */
export function locateQuote(source: string, quote: string): [number, number] | undefined {
  const q = quote.trim();
  if (q.length === 0) return undefined;
  const exact = source.indexOf(q);
  if (exact >= 0) return [exact, exact + q.length];
  const parts = q.split(/\s+/).map(escapeRe);
  try {
    const m = new RegExp(parts.join("\\s+"), "iu").exec(source);
    return m === null ? undefined : [m.index, m.index + m[0].length];
  } catch {
    return undefined;
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

interface Ctx {
  source: CardSource;
  cap: number;
  dropped: DroppedClaim[];
}

/** Digit runs in `value` that the source does not contain: the model made a number up. */
function inventedNumber(value: string, source: string): boolean {
  const nums = value.match(/\d+/g) ?? [];
  return nums.some((n) => !source.includes(n));
}

type ClaimOptions = {
  /** Free text (title, summary, questions): only the quote has to be in the source. */
  free?: boolean;
};

function claim(
  raw: unknown,
  field: string,
  ctx: Ctx,
  opts: ClaimOptions = {},
): CardClaim | undefined {
  const drop = (reason: DroppedClaim["reason"], value = "") => {
    ctx.dropped.push({ field, value: value.slice(0, 120), reason });
    return undefined;
  };
  if (!isRecord(raw) || typeof raw.value !== "string" || typeof raw.quote !== "string")
    return drop("malformed");
  const value = raw.value.trim();
  if (value.length === 0) return drop("malformed");
  const quote = raw.quote.trim().slice(0, MAX_QUOTE);
  const at = locateQuote(ctx.source.text, quote);
  if (at === undefined) return drop("quote-not-in-source", value);
  const cited = ctx.source.text.slice(at[0], at[1]);
  let derived: CardClaim["derived"];
  if (isRecord(raw.derived) && typeof raw.derived.basis === "string") {
    const basis = raw.derived.basis.trim();
    if (basis.length === 0) return drop("no-basis", value);
    derived = { basis: basis.slice(0, 200) };
  } else if (raw.derived !== undefined && raw.derived !== null && raw.derived !== false) {
    return drop("no-basis", value);
  }
  if (derived === undefined) {
    if (opts.free !== true && !fold(cited).includes(fold(value))) {
      return drop("value-not-in-quote", value);
    }
    if (inventedNumber(value, ctx.source.text)) return drop("invented-number", value);
  }
  const c =
    typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? raw.confidence : 0.5;
  const out: CardClaim = {
    value,
    quote: cited,
    start: at[0],
    end: at[1],
    confidence: Math.min(ctx.cap, Math.max(0, c)),
  };
  if (derived !== undefined) out.derived = derived;
  return out;
}

function list<T extends CardClaim>(
  raw: unknown,
  field: string,
  ctx: Ctx,
  extra: (r: Record<string, unknown>, c: CardClaim) => T | undefined,
  opts: ClaimOptions = {},
  max = MAX_ITEMS,
): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, max * 2)) {
    const c = claim(item, field, ctx, opts);
    if (c === undefined || !isRecord(item)) continue;
    const full = extra(item, c);
    if (full === undefined) {
      ctx.dropped.push({ field, value: c.value.slice(0, 120), reason: "malformed" });
      continue;
    }
    const key = fold(full.value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(full);
    if (out.length >= max) break;
  }
  return out;
}

function oneOf<K extends string>(v: unknown, allowed: readonly K[], fallback: K): K {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as K) : fallback;
}

export interface ValidateOptions {
  now: number;
  model: string;
  sourceHash: string;
  /** Maps a person or organisation name to a people-graph entity id. */
  resolvePerson?: (name: string, kind: WhoKind) => string | undefined;
}

/**
 * Turns the model's JSON into a card, keeping only what the source supports: every claim's
 * quote must be in the source text, and (unless marked `derived` with a basis) its value must be
 * inside that quote and invent no numbers. Returns `undefined` when the title or summary cannot
 * be grounded. An untrusted source caps confidence at 0.6 and the card inherits its provenance.
 */
export function validateCard(
  raw: unknown,
  source: CardSource,
  options: ValidateOptions,
): { card?: ContextCard; dropped: DroppedClaim[] } {
  const dropped: DroppedClaim[] = [];
  if (!isRecord(raw)) return { dropped: [{ field: "card", value: "", reason: "malformed" }] };
  const ctx: Ctx = {
    source,
    cap: source.provenance === "untrusted" ? 0.6 : 0.95,
    dropped,
  };
  const title = claim(raw.title, "title", ctx, { free: true });
  const summary = claim(raw.summary, "summary", ctx, { free: true });
  if (title !== undefined && inventedNumber(title.value, source.text)) {
    dropped.push({ field: "title", value: title.value, reason: "invented-number" });
    return { dropped };
  }
  if (title === undefined || summary === undefined) return { dropped };
  if (inventedNumber(summary.value, source.text)) {
    dropped.push({
      field: "summary",
      value: summary.value.slice(0, 120),
      reason: "invented-number",
    });
    return { dropped };
  }
  const why =
    raw.why === undefined || raw.why === null
      ? undefined
      : claim(raw.why, "why", ctx, { free: true });
  const questions = list(raw.questions, "questions", ctx, (_r, c) => c, { free: true }, 5).filter(
    (q) => {
      if (!inventedNumber(q.value, source.text)) return true;
      dropped.push({ field: "questions", value: q.value.slice(0, 120), reason: "invented-number" });
      return false;
    },
  );
  const who = list<CardWho>(raw.who, "who", ctx, (r, c) => {
    const kind = oneOf<WhoKind>(r.kind, ["person", "org"], "person");
    const personId = options.resolvePerson?.(c.value, kind);
    return { ...c, kind, ...(personId === undefined ? {} : { personId }) };
  });
  const what = list<CardWhat>(raw.what, "what", ctx, (r, c) => ({
    ...c,
    kind: oneOf<WhatKind>(r.kind, ["topic", "project", "entity"], "topic"),
  }));
  const when = list<CardWhen>(raw.when, "when", ctx, (r, c) => {
    const out: CardWhen = { ...c };
    if (typeof r.iso === "string" && ISO.test(r.iso) && !Number.isNaN(Date.parse(r.iso))) {
      // A resolved date is a derived value unless the quote already spells it out.
      if (c.derived !== undefined || fold(c.quote).includes(r.iso)) out.iso = r.iso;
      else dropped.push({ field: "when.iso", value: r.iso, reason: "no-basis" });
    }
    return out;
  });
  const where = list<CardWhere>(raw.where, "where", ctx, (r, c) => ({
    ...c,
    kind: oneOf<WhereKind>(r.kind, ["place", "url", "path", "app"], "place"),
  }));
  const tags = list(raw.tags, "tags", ctx, (_r, c) => c, {}, 8);
  const card: ContextCard = {
    version: CARD_VERSION,
    docId: source.id,
    title,
    summary,
    who,
    what,
    when,
    where,
    questions,
    tags,
    eventAt: source.createdAt,
    ingestedAt: options.now,
    provenance: source.provenance,
    source: source.source,
    model: options.model,
    sourceHash: options.sourceHash,
  };
  if (why !== undefined) card.why = why;
  return { card, dropped };
}
