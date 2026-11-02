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
  observedAt: string | null;
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

const words = (q: string): string[] =>
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
  const terms = monthIndex > 0 ? [] : words(text);

  const entities =
    terms.length === 0 && monthIndex > 0
      ? []
      : graph.search(text, {
          kinds: ["person", "org", "project", "place", "event", "topic"],
          limit: 8,
        });

  const rows = db
    .prepare(
      `SELECT f.id, f.entity_id, f.attribute, f.value, f.provenance, f.review, f.last_seen_at
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
      observedAt: first?.observedAt ?? null,
    });
  }
  return { entities, facts: hits, intent: monthIndex > 0 ? `birthday_month:${monthIndex}` : null };
}
