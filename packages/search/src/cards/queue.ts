import type { SqliteSearchIndex } from "../sqlite-index.ts";
import type { GenerateResult } from "./generate.ts";
import { sourceHash } from "./generate.ts";
import type { CardSource } from "./types.ts";

/** Kinds worth a card: whole items, not one-line chat messages. */
export const CARD_KINDS = ["library", "connector", "thread", "idea", "goal", "memory"] as const;
const DAY_MS = 86_400_000;

export interface CardQueueOptions {
  generate: (item: CardSource) => Promise<GenerateResult>;
  /** The owner's setting (`search.cards.enabled`); read on every tick. */
  enabled: () => boolean;
  /** Tokens the model may use per UTC day (default 200 000, about 50 cards). */
  dailyTokenBudget?: number | (() => number | undefined);
  /** Items generated per tick (default 3). */
  batchSize?: number;
  /** Existing documents queued per tick while the queue is empty (default 5). */
  backfillPerTick?: number;
  /** Texts shorter than this get no card (default 200 characters). */
  minChars?: number;
  maxAttempts?: number;
  kinds?: readonly string[];
  /**
   * Producers whose items get no card (a search source set to processing `none`); read on every
   * call, so a switch applies at once.
   */
  blockedSources?: () => readonly string[];
  now?: () => number;
}

export interface CardTickReport {
  generated: number;
  failed: number;
  /** Items whose generation yielded nothing valid. */
  empty: number;
  backfilled: number;
  tokens: number;
  /** Why the tick did nothing more: the switch is off or today's budget is used. */
  paused?: "disabled" | "budget";
}

export interface CardQueueStatus {
  enabled: boolean;
  queued: number;
  cards: number;
  /** Eligible documents still without a card (the backfill's remaining work). */
  missing: number;
  tokensToday: number;
  dailyTokenBudget: number;
}

/**
 * Generates cards in the background: new items are `enqueue`d as they are indexed, and existing
 * ones are queued a few at a time (`backfillPerTick`) once the queue is empty. Nothing runs by
 * itself: the Gateway's scheduler calls `tick()`, which does a bounded amount of work, stops at
 * the daily token budget and does nothing while the setting is off.
 */
export class CardQueue {
  readonly #index: SqliteSearchIndex;
  readonly #o: Required<Omit<CardQueueOptions, "generate" | "enabled">> &
    Pick<CardQueueOptions, "generate" | "enabled">;
  #running = false;

  #budget(): number {
    const b = this.#o.dailyTokenBudget;
    return (typeof b === "function" ? b() : b) ?? 200_000;
  }

  constructor(index: SqliteSearchIndex, options: CardQueueOptions) {
    this.#index = index;
    this.#o = {
      dailyTokenBudget: 200_000,
      batchSize: 3,
      backfillPerTick: 5,
      minChars: 200,
      maxAttempts: 3,
      kinds: CARD_KINDS,
      blockedSources: () => [],
      now: Date.now,
      ...options,
    };
  }

  /** Queues an item for a card. Returns false when it is skipped (off, too short, unchanged). */
  enqueue(item: CardSource): boolean {
    if (!this.#o.enabled()) return false;
    if (!this.#eligible(item)) return false;
    if (this.#index.cards.hashOf(item.id) === sourceHash(item.text)) return false;
    this.#index.db
      .prepare(
        `INSERT INTO search_card_queue (doc_id, payload, enqueued_ms) VALUES (?, ?, ?)
         ON CONFLICT (doc_id) DO UPDATE SET payload = excluded.payload, attempts = 0`,
      )
      .run(item.id, JSON.stringify(item), this.#o.now());
    return true;
  }

  #eligible(item: CardSource): boolean {
    return (
      item.provenance !== "system" &&
      item.text.trim().length >= this.#o.minChars &&
      this.#o.kinds.includes(item.kind) &&
      !(this.#o.blockedSources?.() ?? []).includes(item.source)
    );
  }

  status(): CardQueueStatus {
    const db = this.#index.db;
    return {
      enabled: this.#o.enabled(),
      queued: (db.prepare("SELECT count(*) AS n FROM search_card_queue").get() as { n: number }).n,
      cards: this.#index.cards.count(),
      missing: this.#missingCount(),
      tokensToday: this.#spent(),
      dailyTokenBudget: this.#budget(),
    };
  }

  /** One bounded step: backfill a few documents if idle, then generate up to `batchSize` cards. */
  async tick(): Promise<CardTickReport> {
    const report: CardTickReport = { generated: 0, failed: 0, empty: 0, backfilled: 0, tokens: 0 };
    if (this.#running) return report;
    if (!this.#o.enabled()) return { ...report, paused: "disabled" };
    this.#running = true;
    try {
      if (this.#queued() === 0) report.backfilled = this.#backfill(this.#o.backfillPerTick);
      for (const row of this.#next(this.#o.batchSize)) {
        if (this.#spent() >= this.#budget()) {
          report.paused = "budget";
          break;
        }
        const item = JSON.parse(row.payload) as CardSource;
        const exists = this.#index.db
          .prepare("SELECT 1 FROM search_docs WHERE id = ?")
          .get(item.id);
        if (exists === undefined) {
          this.#drop(item.id);
          continue;
        }
        const res = await this.#o.generate(item);
        this.#addSpent(res.tokens);
        report.tokens += res.tokens;
        if (res.error !== undefined) {
          report.failed++;
          if (row.attempts + 1 >= this.#o.maxAttempts) this.#skip(item);
          else
            this.#index.db
              .prepare("UPDATE search_card_queue SET attempts = attempts + 1 WHERE doc_id = ?")
              .run(item.id);
          continue;
        }
        if (res.card === undefined) {
          report.empty++;
          this.#skip(item);
          continue;
        }
        this.#index.attachCard(res.card);
        this.#drop(item.id);
        report.generated++;
      }
      if (report.paused === undefined && this.#spent() >= this.#budget()) report.paused = "budget";
    } finally {
      this.#running = false;
    }
    return report;
  }

  #next(n: number): { payload: string; attempts: number }[] {
    return this.#index.db
      .prepare("SELECT payload, attempts FROM search_card_queue ORDER BY enqueued_ms LIMIT ?")
      .all(n) as { payload: string; attempts: number }[];
  }

  #queued(): number {
    return (
      this.#index.db.prepare("SELECT count(*) AS n FROM search_card_queue").get() as {
        n: number;
      }
    ).n;
  }

  #drop(id: string): void {
    this.#index.db.prepare("DELETE FROM search_card_queue WHERE doc_id = ?").run(id);
  }

  /** Remembers that this text yielded no card, so the backfill does not retry it forever. */
  #skip(item: CardSource): void {
    this.#drop(item.id);
    this.#setMeta(`cards.skip.${item.id}`, sourceHash(item.text));
  }

  #candidateSql(): string {
    const kinds = this.#o.kinds.map(() => "?").join(", ");
    const blocked = (this.#o.blockedSources?.() ?? []).map((s) => `'${s.replace(/'/g, "''")}'`);
    const notBlocked =
      blocked.length === 0 ? "" : `AND COALESCE(d.source, '') NOT IN (${blocked.join(", ")})`;
    return `FROM search_docs d
      WHERE d.kind IN (${kinds}) AND length(d.body) >= ? AND d.provenance != 'system' ${notBlocked}
        AND NOT EXISTS (SELECT 1 FROM search_cards c WHERE c.doc_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM search_card_queue q WHERE q.doc_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM search_meta m WHERE m.key = 'cards.skip.' || d.id)`;
  }

  #missingCount(): number {
    return (
      this.#index.db
        .prepare(`SELECT count(*) AS n ${this.#candidateSql()}`)
        .get(...this.#o.kinds, this.#o.minChars) as { n: number }
    ).n;
  }

  /** Queues the newest documents without a card. */
  #backfill(n: number): number {
    if (n <= 0) return 0;
    const rows = this.#index.db
      .prepare(
        `SELECT d.id, d.kind, d.title, d.body, d.provenance, d.source, d.created_ms, d.scope_key
         ${this.#candidateSql()} ORDER BY d.created_ms DESC LIMIT ?`,
      )
      .all(...this.#o.kinds, this.#o.minChars, n) as {
      id: string;
      kind: string;
      title: string;
      body: string;
      provenance: CardSource["provenance"];
      source: string | null;
      created_ms: number;
      scope_key: string;
    }[];
    let queued = 0;
    for (const r of rows) {
      const ok = this.enqueue({
        id: r.id,
        kind: r.kind,
        title: r.title,
        text: r.body,
        provenance: r.provenance,
        source: r.source ?? r.kind,
        createdAt: r.created_ms,
        scopeKey: r.scope_key,
      });
      if (ok) queued++;
    }
    return queued;
  }

  #day(): string {
    return new Date(Math.floor(this.#o.now() / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
  }

  #spent(): number {
    return Number(this.#meta(`cards.spent.${this.#day()}`) ?? 0);
  }

  #addSpent(tokens: number): void {
    const today = this.#day();
    this.#index.db
      .prepare("DELETE FROM search_meta WHERE key LIKE 'cards.spent.%' AND key != ?")
      .run(`cards.spent.${today}`);
    this.#setMeta(`cards.spent.${today}`, String(this.#spent() + tokens));
  }

  #meta(key: string): string | undefined {
    return (
      this.#index.db.prepare("SELECT value FROM search_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined
    )?.value;
  }

  #setMeta(key: string, value: string): void {
    this.#index.db
      .prepare(
        "INSERT INTO search_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }
}
