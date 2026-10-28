import type { SqliteSearchIndex } from "../sqlite-index.ts";
import { OWNER_SCOPE, type SearchDoc } from "../types.ts";
import { isExcluded } from "./exclusion.ts";
import { sha256 } from "./text.ts";
import {
  SOURCE_IDS,
  SOURCE_LABELS,
  type SourceAdapter,
  type SourceId,
  type SourceItem,
  type SourceStatus,
  type SourcesConfig,
  type SourcesStatus,
} from "./types.ts";

/** Battery state, from the host. Unknown means "plugged in". */
export interface PowerState {
  onBattery: boolean;
  lowPower: boolean;
}

export interface SourceIndexerOptions {
  /** Read on every call, so a Settings change applies at once. */
  config: () => SourcesConfig;
  now?: () => number;
  power?: () => PowerState;
  /** Items per page (default 100). */
  pageSize?: number;
  /** Pages per source per tick on power (default 5); on battery one page of an already-filled source. */
  pagesPerTick?: number;
  /** Pause between pages, ms (default 25): yields the event loop and the disk. */
  pauseMs?: number;
  /** Time spent in one tick before it yields, ms (default 1500). */
  budgetMs?: number;
  /** Between full sweeps, ms (default 24 h). */
  sweepEveryMs?: number;
  onChange?: () => void;
  onError?: (source: SourceId, err: unknown) => void;
}

const DAY_MS = 86_400_000;
const MIN_DEDUPE_CHARS = 200;

const DDL = `
CREATE TABLE IF NOT EXISTS search_source_items (
  source TEXT NOT NULL,
  native_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  provenance TEXT NOT NULL,
  parties TEXT NOT NULL,
  chat_id TEXT,
  account TEXT,
  path TEXT,
  PRIMARY KEY (source, native_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS search_source_items_hash ON search_source_items (content_hash);
`;

interface Row {
  native_id: string;
  doc_id: string;
  content_hash: string;
  provenance: string;
  parties: string;
  chat_id: string | null;
  account: string | null;
  path: string | null;
}

/** Document source tag in `search_docs.source` (bulk removal, per-source counts). */
export const sourceTag = (id: SourceId): string => `local:${id}`;

/**
 * Keeps the opted-in local sources (Mail, Messages, Notes, Calendar, Reminders, granted folders)
 * in the main index: an incremental cursor per source, content-hash dedupe, deletion by a nightly
 * sweep, the owner's exclusion list, and provenance per item. It runs from the Gateway's existing
 * timer (`tick`), in small throttled steps, and is battery aware. Nothing here starts a process.
 */
export class SourceIndexer {
  readonly #index: SqliteSearchIndex;
  readonly #adapters = new Map<SourceId, SourceAdapter>();
  readonly #o: Required<
    Pick<SourceIndexerOptions, "now" | "pageSize" | "pagesPerTick" | "pauseMs" | "budgetMs">
  > &
    SourceIndexerOptions;
  readonly #errors = new Map<SourceId, string>();
  readonly #active = new Set<SourceId>();
  #abort = new AbortController();
  #running: Promise<void> | undefined;

  constructor(
    index: SqliteSearchIndex,
    adapters: readonly SourceAdapter[],
    options: SourceIndexerOptions,
  ) {
    this.#index = index;
    for (const a of adapters) this.#adapters.set(a.id, a);
    this.#o = {
      ...options,
      now: options.now ?? Date.now,
      pageSize: options.pageSize ?? 100,
      pagesPerTick: options.pagesPerTick ?? 5,
      pauseMs: options.pauseMs ?? 25,
      budgetMs: options.budgetMs ?? 1500,
    };
    index.db.exec(DDL);
    // The index may have been rebuilt under us: forget rows whose document is gone.
    index.db.exec(
      "DELETE FROM search_source_items WHERE NOT EXISTS (SELECT 1 FROM search_docs d WHERE d.id = doc_id)",
    );
  }

  // --- meta ------------------------------------------------------------------------------------

  #meta(key: string): string | undefined {
    return (
      this.#index.db.prepare("SELECT value FROM search_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined
    )?.value;
  }
  #setMeta(key: string, value: string | undefined): void {
    if (value === undefined)
      this.#index.db.prepare("DELETE FROM search_meta WHERE key = ?").run(key);
    else
      this.#index.db
        .prepare(
          "INSERT INTO search_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run(key, value);
  }
  #cursor(id: SourceId): unknown {
    const v = this.#meta(`src.${id}.cursor`);
    return v === undefined ? null : JSON.parse(v);
  }

  // --- passes ----------------------------------------------------------------------------------

  /** One bounded step over every enabled source; also runs the nightly sweep when due. */
  tick(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    const run = this.#tick().finally(() => {
      this.#running = undefined;
    });
    this.#running = run;
    return run;
  }

  async #tick(): Promise<void> {
    const power = this.#o.power?.() ?? { onBattery: false, lowPower: false };
    if (power.lowPower) return;
    const started = this.#o.now();
    const config = this.#o.config();
    for (const id of SOURCE_IDS) {
      if (!config.sources[id].enabled) continue;
      const adapter = this.#adapters.get(id);
      if (adapter === undefined || adapter.unavailable() !== undefined) continue;
      const filled = this.#meta(`src.${id}.backfilled`) === "1";
      // On battery only a source that is already filled keeps up; backfills wait for power.
      if (power.onBattery && !filled) continue;
      const pages = power.onBattery ? 1 : this.#o.pagesPerTick;
      await this.#pull(id, adapter, pages, started);
      if (this.#abort.signal.aborted) return;
      if (!power.onBattery) {
        const last = Number(this.#meta(`src.${id}.sweptAt`) ?? 0);
        if (filled && this.#o.now() - last >= (this.#o.sweepEveryMs ?? DAY_MS))
          await this.sweep(id);
      }
    }
  }

  async #pull(id: SourceId, adapter: SourceAdapter, pages: number, started: number): Promise<void> {
    this.#active.add(id);
    try {
      for (let i = 0; i < pages; i++) {
        const { signal } = this.#abort;
        if (signal.aborted) return;
        const res = await adapter.pull(this.#cursor(id), { signal, limit: this.#o.pageSize });
        const changed = await this.ingest(id, res.items);
        this.#setMeta(`src.${id}.cursor`, JSON.stringify(res.cursor ?? null));
        this.#setMeta(`src.${id}.lastAt`, String(this.#o.now()));
        this.#errors.delete(id);
        if (changed > 0) this.#o.onChange?.();
        if (!res.hasMore) {
          this.#setMeta(`src.${id}.backfilled`, "1");
          return;
        }
        if (this.#o.now() - started > this.#o.budgetMs) return;
        if (this.#o.pauseMs > 0) await new Promise((r) => setTimeout(r, this.#o.pauseMs));
      }
    } catch (err) {
      this.#errors.set(id, err instanceof Error ? err.message : String(err));
      this.#o.onError?.(id, err);
    } finally {
      this.#active.delete(id);
    }
  }

  /** Writes items to the index; returns how many documents were added or changed. */
  async ingest(id: SourceId, items: readonly SourceItem[]): Promise<number> {
    const db = this.#index.db;
    const config = this.#o.config();
    const get = db.prepare("SELECT * FROM search_source_items WHERE source = ? AND native_id = ?");
    const dup = db.prepare(
      "SELECT source, native_id, provenance FROM search_source_items WHERE content_hash = ? AND source != ? LIMIT 1",
    );
    const put = db.prepare(
      `INSERT INTO search_source_items (source, native_id, doc_id, content_hash, provenance, parties, chat_id, account, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, native_id) DO UPDATE SET content_hash = excluded.content_hash,
         provenance = excluded.provenance, parties = excluded.parties`,
    );
    const docs: SearchDoc[] = [];
    const tracked: unknown[][] = [];
    const drop: string[] = [];
    for (const item of items) {
      const docId = `${id}:${item.nativeId}`;
      const existing = get.get(id, item.nativeId) as Row | undefined;
      if (isExcluded(item, config.exclude)) {
        // Edited into the exclusion list: forget it.
        if (existing !== undefined) drop.push(item.nativeId);
        continue;
      }
      const hash = sha256(`${item.title}\n${item.text}`);
      if (existing?.content_hash === hash && existing.provenance === item.provenance) continue;
      if (existing === undefined && item.text.length >= MIN_DEDUPE_CHARS) {
        // The same long text already indexed from another source (a PDF that is also a mail
        // attachment): keep one, unless this copy is the owner's and the other is not.
        const other = dup.get(hash, id) as
          | { source: string; native_id: string; provenance: string }
          | undefined;
        if (other !== undefined) {
          if (!(item.provenance === "owner" && other.provenance === "untrusted")) continue;
          await this.#index.remove(`${other.source}:${other.native_id}`);
          db.prepare("DELETE FROM search_source_items WHERE source = ? AND native_id = ?").run(
            other.source,
            other.native_id,
          );
        }
      }
      docs.push(toDoc(id, item));
      tracked.push([
        id,
        item.nativeId,
        docId,
        hash,
        item.provenance,
        JSON.stringify(item.parties ?? []),
        item.chatId ?? null,
        item.account ?? null,
        item.path ?? null,
      ]);
    }
    for (const nativeId of drop) await this.#forget(id, nativeId);
    if (docs.length > 0) {
      await this.#index.indexMany(docs);
      db.transaction(() => {
        for (const row of tracked) put.run(...row);
      })();
    }
    return docs.length + drop.length;
  }

  async #forget(id: SourceId, nativeId: string): Promise<void> {
    await this.#index.remove(`${id}:${nativeId}`);
    this.#index.db
      .prepare("DELETE FROM search_source_items WHERE source = ? AND native_id = ?")
      .run(id, nativeId);
  }

  /** Removes what the source no longer has (deletes the cursor sources cannot see). */
  async sweep(id: SourceId): Promise<number> {
    const adapter = this.#adapters.get(id);
    if (adapter?.listIds === undefined || adapter.unavailable() !== undefined) return 0;
    try {
      const { ids, complete } = await adapter.listIds(this.#abort.signal);
      if (!complete) return 0;
      const live = new Set(ids);
      const tracked = this.#index.db
        .prepare("SELECT native_id FROM search_source_items WHERE source = ?")
        .all(id) as { native_id: string }[];
      let removed = 0;
      for (const { native_id } of tracked) {
        if (live.has(native_id)) continue;
        await this.#forget(id, native_id);
        removed += 1;
      }
      this.#setMeta(`src.${id}.sweptAt`, String(this.#o.now()));
      if (removed > 0) this.#o.onChange?.();
      return removed;
    } catch (err) {
      this.#errors.set(id, err instanceof Error ? err.message : String(err));
      this.#o.onError?.(id, err);
      return 0;
    }
  }

  // --- config changes --------------------------------------------------------------------------

  /** Drops everything of a source and its cursor (switched off, or before a rebuild). */
  async purge(id: SourceId): Promise<number> {
    const n = await this.#index.removeSource(sourceTag(id));
    this.#index.db.prepare("DELETE FROM search_source_items WHERE source = ?").run(id);
    this.#index.db.prepare("DELETE FROM search_meta WHERE key LIKE ?").run(`src.${id}.%`);
    this.#errors.delete(id);
    this.#o.onChange?.();
    return n;
  }

  /** Call after the config changed: purges sources switched off and items newly excluded. */
  async applyConfig(): Promise<void> {
    const config = this.#o.config();
    for (const id of SOURCE_IDS) {
      if (config.sources[id].enabled) continue;
      const has = this.#index.db
        .prepare("SELECT 1 FROM search_source_items WHERE source = ? LIMIT 1")
        .get(id);
      if (has !== undefined || this.#meta(`src.${id}.cursor`) !== undefined) await this.purge(id);
    }
    const rows = this.#index.db
      .prepare(
        "SELECT source, native_id, provenance, parties, chat_id, account, path FROM search_source_items",
      )
      .all() as (Row & { source: SourceId })[];
    let removed = 0;
    for (const r of rows) {
      const item: SourceItem = {
        nativeId: r.native_id,
        title: "",
        text: "",
        createdAt: 0,
        provenance: "owner",
        parties: JSON.parse(r.parties) as string[],
        ...(r.chat_id === null ? {} : { chatId: r.chat_id }),
        ...(r.account === null ? {} : { account: r.account }),
        ...(r.path === null ? {} : { path: r.path }),
      };
      if (!isExcluded(item, config.exclude)) continue;
      await this.#forget(r.source, r.native_id);
      removed += 1;
    }
    if (removed > 0) this.#o.onChange?.();
  }

  /** Purges a source and reads it again from the start (Settings → Rebuild). */
  async rebuild(id: SourceId): Promise<void> {
    await this.purge(id);
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#running;
    this.#abort = new AbortController();
  }

  // --- status ----------------------------------------------------------------------------------

  status(): SourcesStatus {
    const config = this.#o.config();
    const db = this.#index.db;
    const counts = new Map<string, { n: number; bytes: number }>(
      (
        db
          .prepare(
            `SELECT source, count(*) AS n, sum(length(title) + length(body) + length(extra)) AS bytes
             FROM search_docs WHERE source LIKE 'local:%' GROUP BY source`,
          )
          .all() as { source: string; n: number; bytes: number }[]
      ).map((r) => [r.source, { n: r.n, bytes: r.bytes ?? 0 }]),
    );
    const sources: SourceStatus[] = SOURCE_IDS.map((id) => {
      const cfg = config.sources[id];
      const adapter = this.#adapters.get(id);
      const why = adapter === undefined ? "not supported on this host" : adapter.unavailable();
      const err = this.#errors.get(id);
      const c = counts.get(sourceTag(id));
      const lastAt = this.#meta(`src.${id}.lastAt`);
      const state: SourceStatus["state"] = !cfg.enabled
        ? "off"
        : why !== undefined
          ? "unavailable"
          : err !== undefined
            ? "error"
            : this.#active.has(id) || this.#meta(`src.${id}.backfilled`) !== "1"
              ? "indexing"
              : "idle";
      return {
        id,
        label: SOURCE_LABELS[id],
        enabled: cfg.enabled,
        processing: cfg.processing,
        state,
        ...(cfg.enabled && (why ?? err) !== undefined ? { detail: (why ?? err) as string } : {}),
        items: c?.n ?? 0,
        ...(lastAt === undefined ? {} : { lastIndexedAt: Number(lastAt) }),
        textBytes: c?.bytes ?? 0,
        backfilled: this.#meta(`src.${id}.backfilled`) === "1",
      };
    });
    const size = db
      .prepare(
        "SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()",
      )
      .get() as { bytes: number };
    return { sources, exclude: config.exclude, indexBytes: size.bytes };
  }

  /** Producers whose items get no context card (processing `none`). */
  cardBlocked(): string[] {
    const config = this.#o.config();
    return SOURCE_IDS.filter((id) => config.sources[id].processing === "none").map(sourceTag);
  }
}

function toDoc(id: SourceId, item: SourceItem): SearchDoc {
  return {
    id: `${id}:${item.nativeId}`,
    kind: "connector",
    title: item.title,
    text: item.text,
    provenance: item.provenance,
    ...(item.from === undefined ? {} : { from: item.from }),
    ...(item.mime === undefined ? {} : { mime: item.mime }),
    tags: [id, ...(item.tags ?? [])],
    source: sourceTag(id),
    scopeKey: OWNER_SCOPE,
    createdAt: item.createdAt,
    ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
  };
}
