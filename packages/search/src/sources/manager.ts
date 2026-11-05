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
  /**
   * The owner's "Index on battery" setting, read on every call so a change applies at once. On,
   * first reads, backfills, sweeps and Rebuild also run on battery, at half the pages per tick
   * (`pagesPerTick`, at least one). Low Power Mode still pauses them: macOS asked to save power.
   */
  runOnBattery?: () => boolean;
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

/**
 * How the Mac's power state limits work now. `paused`: Low Power Mode, which stops everything but a
 * source that runs there. `waitsForPower`: on battery with "Index on battery" off, where only a
 * source that is already filled keeps up, one page at a time. `onBattery` with neither: the owner
 * allows it, at half the pages per tick.
 */
interface PowerMode {
  paused: boolean;
  waitsForPower: boolean;
  onBattery: boolean;
}

/** An indexed source passage (`SourceIndexer.document`). */
export interface SourceDocument {
  id: string;
  source: SourceId;
  title: string;
  text: string;
  /** Epoch ms. */
  createdAt: number;
  provenance: "owner" | "agent" | "untrusted" | "system";
  /** Files: the path the file was indexed at. */
  path: string | null;
  /** Mail: the stored Message-ID, when the message was indexed with one. */
  openRef: string | null;
}

/** Why a rebuild was refused. Nothing is removed when it is: the index stays as it was. */
export type RebuildRefusal = "off" | "unavailable" | "power" | "busy";

export class RebuildRefused extends Error {
  readonly reason: RebuildRefusal;
  constructor(reason: RebuildRefusal, message: string) {
    super(message);
    this.name = "RebuildRefused";
    this.reason = reason;
  }
}

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
  open_ref TEXT,
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
  open_ref: string | null;
}

/**
 * Why a rebuild waits, in the owner's terms and naming the real reason: Low Power Mode, battery
 * with "Index on battery" off, or both.
 */
function rebuildPowerMessage(label: string, mode: PowerMode): string {
  const setting = 'turn on "Index on battery" in Settings → Search sources';
  if (mode.paused && mode.waitsForPower)
    return `Low Power Mode is on and the Mac is on battery, so ${label} can't be rebuilt now. Turn off Low Power Mode and plug in (or ${setting}).`;
  if (mode.paused)
    return `Low Power Mode is on, so ${label} can't be rebuilt now: indexing pauses until it is off.`;
  return `The Mac is on battery, so ${label} can't be rebuilt now. Plug in, or ${setting}.`;
}

/** Document source tag in `search_docs.source` (bulk removal, per-source counts). */
export const sourceTag = (id: SourceId): string =>
  `connector:${id === "messages" ? "imessage" : id}`;

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
  /** Sources being rebuilt now: a pass skips them, and a second rebuild is refused. */
  readonly #rebuilding = new Set<SourceId>();
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
    // An index made before `open_ref` existed: add it (older mail opens in the viewer only).
    const cols = index.db.prepare("PRAGMA table_info(search_source_items)").all() as {
      name: string;
    }[];
    if (!cols.some((c) => c.name === "open_ref"))
      index.db.exec("ALTER TABLE search_source_items ADD COLUMN open_ref TEXT");
    // Lookups from the graph (a gist's or a catch-up line's source): by Message-ID, and by chat.
    index.db.exec(
      `CREATE INDEX IF NOT EXISTS search_source_items_open_ref ON search_source_items (source, open_ref);
       CREATE INDEX IF NOT EXISTS search_source_items_chat ON search_source_items (source, chat_id, native_id);`,
    );
    this.#syncAgentFlags();
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

  #mode(): PowerMode {
    const power = this.#o.power?.() ?? { onBattery: false, lowPower: false };
    return {
      paused: power.lowPower,
      waitsForPower: power.onBattery && this.#o.runOnBattery?.() !== true,
      onBattery: power.onBattery,
    };
  }

  /** Pages one source may read in a tick under `mode`. */
  #pages(mode: PowerMode): number {
    if (mode.waitsForPower) return 1;
    return mode.onBattery ? Math.max(1, Math.ceil(this.#o.pagesPerTick / 2)) : this.#o.pagesPerTick;
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

  /**
   * A pass that starts now, or right after the one in flight (which may have skipped a source that
   * was being rebuilt). `tick` alone would hand back the pass in flight and leave the source
   * unread until the next timer.
   */
  kick(): Promise<void> {
    const running = this.#running;
    if (running === undefined) return this.tick();
    return running.then(
      () => this.tick(),
      () => this.tick(),
    );
  }

  /**
   * One source's next pages now, and no other source's: for a change that must reach one index
   * promptly (memory dropped a fact) without a pass over Mail and Files. It waits for the pass in
   * flight, takes the same power rules as `tick`, and does nothing for a source that is off,
   * unavailable, being rebuilt or already being read.
   */
  async pullSource(id: SourceId): Promise<void> {
    await this.#running?.catch(() => undefined);
    const adapter = this.#adapters.get(id);
    if (adapter === undefined || !this.#o.config().sources[id].enabled) return;
    if (this.#rebuilding.has(id) || this.#active.has(id) || adapter.unavailable() !== undefined)
      return;
    const mode = this.#mode();
    if (mode.paused && adapter.runsOnLowPower !== true) return;
    if (mode.waitsForPower && this.#meta(`src.${id}.backfilled`) !== "1") return;
    await this.#pull(id, adapter, this.#pages(mode), this.#o.now());
  }

  async #tick(): Promise<void> {
    const mode = this.#mode();
    const started = this.#o.now();
    const config = this.#o.config();
    for (const id of SOURCE_IDS) {
      if (!config.sources[id].enabled || this.#rebuilding.has(id)) continue;
      const adapter = this.#adapters.get(id);
      if (adapter === undefined || adapter.unavailable() !== undefined) continue;
      // Low Power Mode pauses everything but a source that is a cheap local read, so that what
      // memory dropped (a fact retracted, a person hidden) leaves the index at once.
      if (mode.paused && adapter.runsOnLowPower !== true) continue;
      const filled = this.#meta(`src.${id}.backfilled`) === "1";
      // On battery (unless the owner allows it) only a source that is already filled keeps up;
      // backfills wait for power.
      if (mode.waitsForPower && !filled) continue;
      await this.#pull(id, adapter, this.#pages(mode), started);
      if (this.#abort.signal.aborted) return;
      if (!mode.waitsForPower && !mode.paused) {
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
        let changed = await this.ingest(id, res.items);
        if (res.snapshot === true && !res.hasMore)
          changed += await this.#forgetMissing(id, new Set(res.items.map((i) => i.nativeId)));
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
      `INSERT INTO search_source_items (source, native_id, doc_id, content_hash, provenance, parties, chat_id, account, path, open_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, native_id) DO UPDATE SET content_hash = excluded.content_hash,
         provenance = excluded.provenance, parties = excluded.parties,
         open_ref = COALESCE(excluded.open_ref, open_ref)`,
    );
    const docs: SearchDoc[] = [];
    const tracked: unknown[][] = [];
    const drop: string[] = [];
    const refOnly: [string, SourceId, string][] = [];
    for (const item of items) {
      const docId = `${id}:${item.nativeId}`;
      const existing = get.get(id, item.nativeId) as Row | undefined;
      if (isExcluded(item, config.exclude)) {
        // Edited into the exclusion list: forget it.
        if (existing !== undefined) drop.push(item.nativeId);
        continue;
      }
      // The parent a result collapses onto is part of what is stored, so a changed parent (the
      // person turned private, hidden or merged) re-indexes the item instead of being skipped.
      const hash = sha256(
        item.parentId === undefined
          ? `${item.title}\n${item.text}`
          : `${item.title}\n${item.text}\n\u0000parent:${item.parentId}`,
      );
      // Unchanged text is skipped, but not when who it involves changed: the exclusion list works
      // from the stored parties (a person linked to a project later), so they are kept current.
      if (
        existing?.content_hash === hash &&
        existing.provenance === item.provenance &&
        existing.parties === JSON.stringify(item.parties ?? [])
      ) {
        // Only the Message-ID is new (mail indexed before it was kept): record it, and leave the
        // document alone, so nothing is re-indexed or re-embedded because of it.
        if (item.openRef !== undefined && existing.open_ref !== item.openRef)
          refOnly.push([item.openRef, id, item.nativeId]);
        continue;
      }
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
        item.openRef ?? null,
      ]);
    }
    for (const [ref, source, nativeId] of refOnly)
      db.prepare(
        "UPDATE search_source_items SET open_ref = ? WHERE source = ? AND native_id = ?",
      ).run(ref, source, nativeId);
    for (const nativeId of drop) await this.#forget(id, nativeId);
    if (docs.length > 0) {
      await this.#index.indexMany(docs);
      db.transaction(() => {
        for (const row of tracked) put.run(...row);
      })();
    }
    return docs.length + drop.length;
  }

  /**
   * One indexed source passage by document id, for the source viewer and the desktop's opener.
   * `audience` "owner" is the owner's own screens (every source, Messages, Contacts and Memory
   * included); "agent" gets nothing from a source the owner kept from the agent (`agent` off, or
   * flagged in the index), the same rule as `search_everything`. Other scopes and ids that are not a
   * source passage give undefined.
   */
  document(id: string, audience: "owner" | "agent" = "agent"): SourceDocument | undefined {
    const row = this.#index.db
      .prepare(
        `SELECT s.source AS source, s.path AS path, s.open_ref AS open_ref, d.id AS id, d.title AS title,
                d.body AS body, d.provenance AS provenance, d.created_ms AS created_ms, d.scope_key AS scope_key
           FROM search_source_items s JOIN search_docs d ON d.id = s.doc_id WHERE s.doc_id = ?`,
      )
      .get(id) as
      | {
          source: string;
          path: string | null;
          open_ref: string | null;
          id: string;
          title: string;
          body: string;
          provenance: SourceDocument["provenance"];
          created_ms: number;
          scope_key: string;
        }
      | undefined;
    if (row === undefined || row.scope_key !== OWNER_SCOPE) return undefined;
    const source = row.source as SourceId;
    if (!SOURCE_IDS.includes(source)) return undefined;
    if (audience === "agent") {
      if (!this.#o.config().sources[source].agent) return undefined;
      if (!this.#index.agentSearchable(sourceTag(source))) return undefined;
    }
    return {
      id: row.id,
      source,
      title: row.title,
      text: row.body,
      createdAt: row.created_ms,
      provenance: row.provenance,
      path: row.path,
      openRef: row.open_ref,
    };
  }

  /**
   * The indexed passage a conversation in the graph was read from, as a document id, or undefined
   * when it is not indexed (or the source is off). `externalRef` is the graph's own reference: a
   * Message-ID for mail, `<chat>:<day>` for a Messages day, the event id for a meeting. It is read
   * fresh each time, so a document id that was reused for another message never answers for the
   * old one. This only finds the id; whether a caller may open it is `sourceOf()` and the
   * Gateway's checks. A day is labelled `sentAt.slice(0, 10)` here and in the graph from the same
   * helper string, so the label is matched exactly: a day not indexed yet has no passage (it is
   * never answered with another day's).
   */
  docIdFor(ref: { kind: "mail" | "message" | "meeting"; externalRef: string }): string | undefined {
    const db = this.#index.db;
    let row: { doc_id: string; source: string } | undefined;
    if (ref.kind === "mail") {
      row = db
        .prepare(
          "SELECT doc_id, source FROM search_source_items WHERE source = 'mail' AND open_ref = ? LIMIT 1",
        )
        .get(ref.externalRef) as typeof row;
    } else if (ref.kind === "meeting") {
      row = db
        .prepare(
          "SELECT doc_id, source FROM search_source_items WHERE source = 'calendar' AND native_id = ?",
        )
        .get(ref.externalRef) as typeof row;
    } else {
      const cut = ref.externalRef.lastIndexOf(":");
      if (cut <= 0) return undefined;
      const chat = ref.externalRef.slice(0, cut);
      const lo = `${chat}|${ref.externalRef.slice(cut + 1)}|`;
      // `chat|day|<row>`: a range over the day's fragments (`}` follows `|`), the first by time.
      row = db
        .prepare(
          `SELECT s.doc_id AS doc_id, s.source AS source FROM search_source_items s
             JOIN search_docs d ON d.id = s.doc_id
            WHERE s.source = 'messages' AND s.chat_id = ? AND s.native_id >= ? AND s.native_id < ?
            ORDER BY d.created_ms, s.native_id LIMIT 1`,
        )
        .get(chat, lo, `${lo.slice(0, -1)}}`) as typeof row;
    }
    if (row === undefined || !this.#o.config().sources[row.source as SourceId]?.enabled)
      return undefined;
    return row.doc_id;
  }

  /**
   * Which source a document id belongs to, without loading its body: for a cheap "may this
   * connection open it" check. Undefined for an unknown id or one that is not an owner-scoped
   * source passage.
   */
  sourceOf(id: string): SourceId | undefined {
    const row = this.#index.db
      .prepare(
        `SELECT s.source AS source, d.scope_key AS scope_key FROM search_source_items s
           JOIN search_docs d ON d.id = s.doc_id WHERE s.doc_id = ?`,
      )
      .get(id) as { source: string; scope_key: string } | undefined;
    if (row === undefined || row.scope_key !== OWNER_SCOPE) return undefined;
    return SOURCE_IDS.includes(row.source as SourceId) ? (row.source as SourceId) : undefined;
  }

  /** Forgets what a whole read of the source no longer has; returns how many documents went. */
  async #forgetMissing(id: SourceId, present: ReadonlySet<string>): Promise<number> {
    const tracked = this.#index.db
      .prepare("SELECT native_id FROM search_source_items WHERE source = ?")
      .all(id) as { native_id: string }[];
    let removed = 0;
    for (const { native_id } of tracked) {
      if (present.has(native_id)) continue;
      await this.#forget(id, native_id);
      removed += 1;
    }
    return removed;
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
    if (adapter === undefined) return 0;
    let expired = 0;
    if (adapter.retentionMs !== undefined) expired = await this.#expire(id, adapter.retentionMs);
    if (adapter.listIds === undefined || adapter.unavailable() !== undefined) {
      if (adapter.retentionMs !== undefined)
        this.#setMeta(`src.${id}.sweptAt`, String(this.#o.now()));
      return expired;
    }
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
      return removed + expired;
    } catch (err) {
      this.#errors.set(id, err instanceof Error ? err.message : String(err));
      this.#o.onError?.(id, err);
      return 0;
    }
  }

  /** Removes a source's items older than `retentionMs` (by the document's date). */
  async #expire(id: SourceId, retentionMs: number): Promise<number> {
    const rows = this.#index.db
      .prepare(
        `SELECT s.native_id FROM search_source_items s JOIN search_docs d ON d.id = s.doc_id
         WHERE s.source = ? AND d.created_ms < ?`,
      )
      .all(id, this.#o.now() - retentionMs) as { native_id: string }[];
    for (const { native_id } of rows) await this.#forget(id, native_id);
    if (rows.length > 0) this.#o.onChange?.();
    return rows.length;
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
    this.#syncAgentFlags();
    for (const id of SOURCE_IDS) {
      if (config.sources[id].enabled) continue;
      const has = this.#index.db
        .prepare("SELECT 1 FROM search_source_items WHERE source = ? LIMIT 1")
        .get(id);
      if (has !== undefined || this.#meta(`src.${id}.cursor`) !== undefined) await this.purge(id);
    }
    for (const id of SOURCE_IDS) {
      if (!config.sources[id].enabled) continue;
      const was = this.#meta(`src.${id}.ocr`) === "1";
      const now = config.sources[id].ocr;
      if (was === now) continue;
      if (now) {
        // Turned on: walk the source again so images and scans are read (unchanged items are
        // skipped by their hash).
        this.#setMeta(`src.${id}.ocr`, "1");
        this.#setMeta(`src.${id}.cursor`, undefined);
        this.#setMeta(`src.${id}.backfilled`, undefined);
      } else {
        // Turned off: text read from images leaves the index with the setting.
        await this.purge(id);
      }
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

  /** Mirrors each source's agent-access choice into the index's per-source flag. */
  #syncAgentFlags(): void {
    const config = this.#o.config();
    for (const id of SOURCE_IDS)
      this.#index.setAgentSearchable(sourceTag(id), config.sources[id].agent);
  }

  /**
   * Purges a source so the next passes read it again from the start (Settings → Rebuild). It
   * refuses, removing nothing, when the source is off, cannot be read now (the Mac helper is not
   * connected) or the Mac cannot index now (Low Power Mode, or battery with "Index on battery" off: a first read waits): purging then would leave
   * the index empty with no way to fill it. It waits for the pass in flight first, because a pull
   * that is mid-page writes its cursor when it finishes and the rebuild would resume from there.
   * Callers follow it with `kick()`.
   */
  async rebuild(id: SourceId): Promise<void> {
    const label = SOURCE_LABELS[id];
    if (!this.#o.config().sources[id].enabled)
      throw new RebuildRefused("off", `Turn ${label} on first.`);
    const adapter = this.#adapters.get(id);
    const why = adapter === undefined ? "not supported on this host" : adapter.unavailable();
    if (why !== undefined)
      throw new RebuildRefused(
        "unavailable",
        `${label} can't be read right now (${why}), so it was left as it is.`,
      );
    const mode = this.#mode();
    if (mode.paused || mode.waitsForPower)
      throw new RebuildRefused("power", rebuildPowerMessage(label, mode));
    if (this.#rebuilding.has(id))
      throw new RebuildRefused("busy", `${label} is already being rebuilt.`);
    this.#rebuilding.add(id);
    try {
      await this.#running?.catch(() => undefined);
      await this.purge(id);
    } finally {
      this.#rebuilding.delete(id);
    }
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
             FROM search_docs WHERE source IN (${SOURCE_IDS.map(() => "?").join(", ")}) GROUP BY source`,
          )
          .all(...SOURCE_IDS.map(sourceTag)) as { source: string; n: number; bytes: number }[]
      ).map((r) => [r.source, { n: r.n, bytes: r.bytes ?? 0 }]),
    );
    // A source this host has no adapter for (Notes and Messages on Windows) is not listed at all:
    // a row that can never be switched on is noise.
    const sources: SourceStatus[] = SOURCE_IDS.filter((id) => this.#adapters.has(id)).map((id) => {
      const cfg = config.sources[id];
      const adapter = this.#adapters.get(id) as SourceAdapter;
      const why = adapter.unavailable();
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
        agent: cfg.agent,
        ocr: cfg.ocr,
        state,
        ...(cfg.enabled && (why ?? err) !== undefined ? { detail: (why ?? err) as string } : {}),
        ...(adapter?.cannotEnable?.() === undefined
          ? {}
          : { cannotEnable: adapter.cannotEnable() as string }),
        ...(adapter?.cannotAgent?.() === undefined
          ? {}
          : { cannotAgent: adapter.cannotAgent() as string }),
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

  /**
   * Producers whose text may not reach a cloud model at all: processing `none` or `local`. The
   * agent's answers and deep research drop their hits when the model that reads them is cloud.
   */
  cloudBlocked(): string[] {
    const config = this.#o.config();
    return SOURCE_IDS.filter((id) => config.sources[id].processing !== "cloud").map(sourceTag);
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
    ...(item.parentId === undefined ? {} : { parentId: item.parentId }),
    tags: [id, ...(item.tags ?? [])],
    source: sourceTag(id),
    scopeKey: OWNER_SCOPE,
    createdAt: item.createdAt,
    ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
  };
}
