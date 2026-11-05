import type {
  EntitySummary,
  GraphFactAttribute,
  GraphReviewState,
  Provenance,
} from "@psyche/protocol";
import type { EverythingStore } from "./everything.ts";
import type { GraphStore } from "./store.ts";
import { parseMonthDay } from "./upcoming.ts";

/**
 * The Life search scope (docs/design/everything-memory-2026.md §12.4): people, orgs, events and
 * topics by name, and cited facts by their words, for the owner. Facts still waiting for review
 * are included and marked, because the owner can see them; the agent never reads this (it reads
 * through `people_lookup` and the access rules). Lexical only for now: every word of the query
 * must appear in the fact (its attribute, value, quote) or the person's name, and a few plain
 * intents ("birthdays in March") are read out of the question.
 */

export interface LifeFactHit {
  factId: string;
  entity: EntitySummary;
  attribute: GraphFactAttribute;
  value: string;
  provenance: Provenance;
  review: GraphReviewState;
  /** The first cited quote, verbatim, or null. */
  quote: string | null;
  /** Where it came from (`mail`, `notes`, …) or null. */
  source: string | null;
  /** The search document id of that citation's source passage, when it is indexed. */
  docId: string | null;
  /** Every citation's indexed passage, in order (at most 5), found at read time from the citations. */
  docIds: string[];
  /** Every citation's source kind, without repeats (at most 8). */
  sources: string[];
  observedAt: string | null;
  /** When Psyche first learned it (first seen, else recorded). */
  learnedAt: string | null;
}

/** The search document ids of a fact's citations, without repeats. Read from the citations each time, never kept on the fact. */
export function docIdsOf(cites: readonly { docId?: string | null }[]): string[] {
  return [
    ...new Set(cites.flatMap((c) => (c.docId == null || c.docId === "" ? [] : [c.docId]))),
  ].slice(0, 5);
}

/** The source kinds of a fact's citations, without repeats. */
export function sourcesOf(cites: readonly { source?: string | null }[]): string[] {
  return [
    ...new Set(cites.flatMap((c) => (c.source == null || c.source === "" ? [] : [c.source]))),
  ].slice(0, 8);
}

export interface LifeResult {
  entities: EntitySummary[];
  facts: LifeFactHit[];
  /** A question the search understood, for a chip: `birthday_month:3`. */
  intent: string | null;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "is",
  "are",
  "who",
  "whose",
  "what",
  "did",
  "do",
  "does",
  "my",
  "me",
  "i",
  "to",
  "at",
  "on",
  "for",
  "and",
  "with",
  "about",
  "tell",
  "told",
  "said",
  "say",
  "says",
]);

/** Plain words a question uses for an attribute ("works at" is the employer). */
const SYNONYMS: Partial<Record<GraphFactAttribute, string>> = {
  employer: "work works working worked job company employed",
  title: "work works job role position",
  role: "work job position",
  city: "live lives living lived located based",
  hometown: "grew from raised",
  birthday: "born birthday birthdays",
  school: "studied studies study went attends attended",
  likes: "like likes love loves enjoy enjoys",
  dislikes: "dislike dislikes hate hates",
  pet_names: "pet pets dog cat",
  children_names: "child children kid kids son daughter",
  partner_name: "partner wife husband spouse married",
};

const fold = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

export const lifeTerms = (q: string): string[] =>
  (fold(q).match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2 && !STOP.has(w)).slice(0, 8);

export function lifeSearch(
  graph: GraphStore,
  em: EverythingStore,
  db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } },
  q: string,
  opts: { limit?: number; now?: number } = {},
): LifeResult {
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 50);
  const now = new Date(opts.now ?? Date.now()).toISOString();
  const text = q.trim();
  if (text === "") return { entities: [], facts: [], intent: null };

  // "birthdays in March", "whose birthday is in march"
  const birthdayMonth =
    /\bbirthdays?\b.*\b(?:in|during|this)?\s*(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.exec(
      text,
    );
  const monthIndex = birthdayMonth
    ? MONTHS.indexOf((birthdayMonth[1] as string).toLowerCase()) + 1
    : 0;
  const terms = monthIndex > 0 ? [] : lifeTerms(text);

  const entities =
    terms.length === 0 && monthIndex > 0
      ? []
      : graph.search(text, {
          kinds: ["person", "org", "project", "place", "event", "topic"],
          limit: 8,
        });

  const rows = db
    .prepare(
      `SELECT f.id, f.entity_id, f.attribute, f.value, f.provenance, f.review, f.last_seen_at,
              f.first_seen_at, f.recorded_at
         FROM graph_facts f JOIN graph_entities e ON e.id = f.entity_id
        WHERE e.hidden = 0 AND e.status = 'active' AND f.retracted_at IS NULL AND f.superseded_by IS NULL
          AND (f.valid_to IS NULL OR f.valid_to > ?) AND f.review IN ('accepted', 'auto_accepted', 'edited', 'pending')
        ORDER BY f.last_seen_at DESC, f.id LIMIT 4000`,
    )
    .all(now) as {
    id: string;
    entity_id: string;
    attribute: GraphFactAttribute;
    value: string;
    provenance: Provenance;
    review: GraphReviewState;
    last_seen_at: string | null;
    first_seen_at: string | null;
    recorded_at: string | null;
  }[];

  const hits: LifeFactHit[] = [];
  for (const r of rows) {
    if (hits.length >= limit) break;
    if (monthIndex > 0) {
      if (r.attribute !== "birthday") continue;
      if (parseMonthDay(r.value)?.month !== monthIndex) continue;
    }
    const entity = graph.summary(r.entity_id);
    if (entity === undefined) continue;
    const cites = em.citations("fact", r.id);
    const first = cites[0];
    if (terms.length > 0) {
      const hay = fold(
        `${r.attribute.replace(/_/g, " ")} ${SYNONYMS[r.attribute] ?? ""} ${r.value} ${entity.name} ${cites.map((c) => c.quote).join(" ")}`,
      );
      if (!terms.every((t) => hay.includes(t))) continue;
    }
    hits.push({
      factId: r.id,
      entity,
      attribute: r.attribute,
      value: r.value,
      provenance: r.provenance,
      review: r.review,
      quote: first?.quote ?? null,
      source: first?.source ?? null,
      docId: first?.docId ?? null,
      docIds: docIdsOf(cites),
      sources: sourcesOf(cites),
      observedAt: first?.observedAt ?? null,
      learnedAt: r.first_seen_at ?? r.recorded_at,
    });
  }
  return { entities, facts: hits, intent: monthIndex > 0 ? `birthday_month:${monthIndex}` : null };
}

/** A fact as the semantic search and the answer see it. */
export interface LifeCandidate {
  hit: LifeFactHit;
  /** Anything but `none` is never embedded and never sent to a model for an answer. */
  sensitive: boolean;
}

/** Every visible, current fact (reviewed or waiting), newest first, for ranking by meaning. */
export function lifeCandidates(
  graph: GraphStore,
  em: EverythingStore,
  db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } },
  now: number,
  max = 2000,
  /** Only these facts, looked up by id: the newest-first limit does not apply. */
  ids?: readonly string[],
): LifeCandidate[] {
  if (ids !== undefined && ids.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT f.id, f.entity_id, f.attribute, f.value, f.provenance, f.review, f.sensitivity,
              f.first_seen_at, f.recorded_at
         FROM graph_facts f JOIN graph_entities e ON e.id = f.entity_id
        WHERE e.hidden = 0 AND e.status = 'active' AND f.retracted_at IS NULL AND f.superseded_by IS NULL
          AND (f.valid_to IS NULL OR f.valid_to > ?) AND f.review IN ('accepted', 'auto_accepted', 'edited', 'pending')
          ${ids === undefined ? "" : `AND f.id IN (${ids.map(() => "?").join(",")})`}
        ORDER BY f.last_seen_at DESC, f.id LIMIT ?`,
    )
    .all(new Date(now).toISOString(), ...(ids ?? []), ids === undefined ? max : ids.length) as {
    id: string;
    entity_id: string;
    attribute: GraphFactAttribute;
    value: string;
    provenance: Provenance;
    review: GraphReviewState;
    sensitivity: string;
    first_seen_at: string | null;
    recorded_at: string | null;
  }[];
  const out: LifeCandidate[] = [];
  for (const r of rows) {
    const entity = graph.summary(r.entity_id);
    if (entity === undefined) continue;
    const cites = em.citations("fact", r.id);
    const first = cites[0];
    out.push({
      sensitive: r.sensitivity !== "none",
      hit: {
        factId: r.id,
        entity,
        attribute: r.attribute,
        value: r.value,
        provenance: r.provenance,
        review: r.review,
        quote: first?.quote ?? null,
        source: first?.source ?? null,
        docId: first?.docId ?? null,
        docIds: docIdsOf(cites),
        sources: sourcesOf(cites),
        observedAt: first?.observedAt ?? null,
        learnedAt: r.first_seen_at ?? r.recorded_at,
      },
    });
  }
  return out;
}

/**
 * For a question in plain words ("where does Sam work?"): the hits that match every word, else the
 * union of the hits for each single word, so one stray word does not hide the answer.
 */
export function lifeFactsForQuestion(
  graph: GraphStore,
  em: EverythingStore,
  db: { prepare(sql: string): { all(...a: unknown[]): unknown[] } },
  q: string,
  opts: { limit?: number; now?: number } = {},
): LifeFactHit[] {
  const limit = opts.limit ?? 20;
  const all = lifeSearch(graph, em, db, q, opts).facts;
  if (all.length > 0) return all;
  const seen = new Map<string, LifeFactHit>();
  for (const t of lifeTerms(q).filter((w) => w.length >= 3)) {
    for (const h of lifeSearch(graph, em, db, t, { ...opts, limit }).facts) seen.set(h.factId, h);
  }
  return [...seen.values()].slice(0, limit);
}
