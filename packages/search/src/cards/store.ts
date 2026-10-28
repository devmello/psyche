import type Database from "better-sqlite3";
import { cardDates, cardEntities, cardText } from "./text.ts";
import type { ContextCard } from "./types.ts";

/**
 * Cards live in the search index file, next to the documents they describe: `search_cards` (the
 * card and its full-text), `search_card_entities` and `search_card_dates` (columns for filtering)
 * and `search_card_queue` (items waiting for generation). A trigger removes a document's card
 * with the document, so a deleted or incognito item leaves nothing behind.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS search_cards (
  doc_id TEXT PRIMARY KEY,
  card TEXT NOT NULL CHECK (json_valid(card)),
  fts TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  provenance TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS search_card_entities (
  doc_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  person_id TEXT
);
CREATE INDEX IF NOT EXISTS search_card_entities_name ON search_card_entities (name);
CREATE INDEX IF NOT EXISTS search_card_entities_doc ON search_card_entities (doc_id);
CREATE TABLE IF NOT EXISTS search_card_dates (
  doc_id TEXT NOT NULL,
  day_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS search_card_dates_day ON search_card_dates (day_ms);
CREATE INDEX IF NOT EXISTS search_card_dates_doc ON search_card_dates (doc_id);
CREATE TABLE IF NOT EXISTS search_card_queue (
  doc_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  enqueued_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS search_docs_cards_ad AFTER DELETE ON search_docs BEGIN
  DELETE FROM search_cards WHERE doc_id = old.id;
  DELETE FROM search_card_entities WHERE doc_id = old.id;
  DELETE FROM search_card_dates WHERE doc_id = old.id;
  DELETE FROM search_card_queue WHERE doc_id = old.id;
END;
`;

/** Creates the card tables (idempotent); needs `search_docs`. */
export function ensureCardSchema(db: Database.Database): void {
  db.exec(DDL);
}

/** What a result shows: the card's summary and the span that grounds it. */
export interface CardPreview {
  summary: string;
  /** Source text the summary cites. */
  span: string;
  questions: string[];
  confidence: number;
}

export class CardStore {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
    ensureCardSchema(db);
  }

  /** Full text of the card for the FTS `extra` column (empty without a card). */
  ftsFor(docId: string): string {
    const row = this.#db.prepare("SELECT fts FROM search_cards WHERE doc_id = ?").get(docId) as
      | { fts: string }
      | undefined;
    return row?.fts ?? "";
  }

  get(docId: string): ContextCard | undefined {
    const row = this.#db.prepare("SELECT card FROM search_cards WHERE doc_id = ?").get(docId) as
      | { card: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.card) as ContextCard);
  }

  /** Hash of the source a stored card was generated from. */
  hashOf(docId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT source_hash AS h FROM search_cards WHERE doc_id = ?")
      .get(docId) as { h: string } | undefined;
    return row?.h;
  }

  has(docId: string): boolean {
    return this.hashOf(docId) !== undefined;
  }

  count(): number {
    return (this.#db.prepare("SELECT count(*) AS n FROM search_cards").get() as { n: number }).n;
  }

  /** Stores the card and its filter rows. The document must exist in `search_docs`. */
  put(card: ContextCard): void {
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO search_cards (doc_id, card, fts, source_hash, provenance, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (doc_id) DO UPDATE SET card = excluded.card, fts = excluded.fts,
             source_hash = excluded.source_hash, provenance = excluded.provenance,
             updated_ms = excluded.updated_ms`,
        )
        .run(
          card.docId,
          JSON.stringify(card),
          cardText(card),
          card.sourceHash,
          card.provenance,
          card.ingestedAt,
        );
      this.#db.prepare("DELETE FROM search_card_entities WHERE doc_id = ?").run(card.docId);
      this.#db.prepare("DELETE FROM search_card_dates WHERE doc_id = ?").run(card.docId);
      const ent = this.#db.prepare(
        "INSERT INTO search_card_entities (doc_id, name, kind, person_id) VALUES (?, ?, ?, ?)",
      );
      for (const e of cardEntities(card)) ent.run(card.docId, e.name, e.kind, e.personId ?? null);
      const day = this.#db.prepare("INSERT INTO search_card_dates (doc_id, day_ms) VALUES (?, ?)");
      for (const d of cardDates(card)) day.run(card.docId, d);
    })();
  }

  /** Previews for result rows, by document id. */
  previews(docIds: readonly string[]): Map<string, CardPreview> {
    const out = new Map<string, CardPreview>();
    if (docIds.length === 0) return out;
    const rows = this.#db
      .prepare(
        `SELECT doc_id, card FROM search_cards WHERE doc_id IN (${docIds.map(() => "?").join(", ")})`,
      )
      .all(...docIds) as { doc_id: string; card: string }[];
    for (const r of rows) {
      const card = JSON.parse(r.card) as ContextCard;
      out.set(r.doc_id, {
        summary: card.summary.value,
        span: card.summary.quote,
        questions: card.questions.map((q) => q.value),
        confidence: card.summary.confidence,
      });
    }
    return out;
  }

  /** Documents whose card names the entity (case-folded), newest first. */
  docsForEntity(name: string, limit = 50): string[] {
    return (
      this.#db
        .prepare(
          `SELECT DISTINCT e.doc_id AS id FROM search_card_entities e
           JOIN search_docs d ON d.id = e.doc_id
           WHERE e.name = ? ORDER BY d.created_ms DESC LIMIT ?`,
        )
        .all(name.normalize("NFC").toLowerCase().trim(), limit) as { id: string }[]
    ).map((r) => r.id);
  }

  /** Documents whose card mentions a day in `[from, to)` (epoch ms), newest first. */
  docsForDates(from: number, to: number, limit = 50): string[] {
    return (
      this.#db
        .prepare(
          `SELECT DISTINCT x.doc_id AS id FROM search_card_dates x
           JOIN search_docs d ON d.id = x.doc_id
           WHERE x.day_ms >= ? AND x.day_ms < ? ORDER BY d.created_ms DESC LIMIT ?`,
        )
        .all(from, to, limit) as { id: string }[]
    ).map((r) => r.id);
  }
}
