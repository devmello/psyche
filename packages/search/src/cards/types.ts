import type { Provenance } from "@psyche/protocol";

/**
 * Context cards: a structured, grounded description generated for an item when it is indexed
 * (docs/design/grounded-ingest-2026.md). Every claim cites a span of the source and carries a
 * confidence; claims whose cited text is not in the source are dropped by `validateCard`.
 */

/** One claim of a card: a value, the source text that supports it, and how sure we are. */
export interface CardClaim {
  value: string;
  /** Exact text of the source that supports the claim (verified by validation). */
  quote: string;
  /** `[start, end)` offsets of `quote` in the source text. */
  start: number;
  end: number;
  /** 0–1; untrusted sources are capped lower. */
  confidence: number;
  /** Set when `value` is not literally in the source (a resolved "next Friday"): the basis. */
  derived?: { basis: string };
}

export type WhoKind = "person" | "org";
export type WhatKind = "topic" | "project" | "entity";
export type WhereKind = "place" | "url" | "path" | "app";

export interface CardWho extends CardClaim {
  kind: WhoKind;
  /** People-graph entity id when the name resolved to one. */
  personId?: string;
}
export interface CardWhat extends CardClaim {
  kind: WhatKind;
}
export interface CardWhen extends CardClaim {
  /** `YYYY-MM-DD` the mention resolves to; present only when literal or `derived`. */
  iso?: string;
}
export interface CardWhere extends CardClaim {
  kind: WhereKind;
}

export const CARD_VERSION = 1;

export interface ContextCard {
  version: number;
  docId: string;
  title: CardClaim;
  /** One paragraph; its `quote` is the passage it summarises. */
  summary: CardClaim;
  who: CardWho[];
  what: CardWhat[];
  when: CardWhen[];
  where: CardWhere[];
  why?: CardClaim;
  /** 2–5 natural questions the item answers; `quote` is the span that answers each. */
  questions: CardClaim[];
  tags: CardClaim[];
  /** When the thing happened (epoch ms, the item's own date) versus when it was indexed. */
  eventAt: number;
  ingestedAt: number;
  /** Least-trusted provenance of the source: a card of an untrusted source is untrusted data. */
  provenance: Provenance;
  /** Where the item came from: `mail`, `library`, `memory`, … */
  source: string;
  model: string;
  /** sha256 of the source text the card was generated from. */
  sourceHash: string;
}

/** What card generation reads. */
export interface CardSource {
  id: string;
  kind: string;
  title: string;
  text: string;
  provenance: Provenance;
  /** App or producer: `mail`, `library`, `memory`, … */
  source: string;
  /** Epoch ms of the item itself. */
  createdAt: number;
  scopeKey?: string;
}

export interface DroppedClaim {
  field: string;
  value: string;
  reason:
    | "quote-not-in-source"
    | "value-not-in-quote"
    | "invented-number"
    | "malformed"
    | "no-basis";
}
