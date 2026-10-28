/**
 * Indexes the synthetic corpus through the real source indexers (roadmap §2) instead of writing
 * documents straight into the index: a fake Apple connector, a fake Messages helper and a temp
 * folder stand in for Mail, Messages, Notes, Calendar, Reminders and files, and `SourceIndexer`
 * does the rest (cursors, chunking into one doc per message or conversation-day, dedupe,
 * provenance). Hits are mapped back to corpus ids so the gold sets still apply:
 *
 *  - Messages become one document per chat and day, so a hit on one credits every corpus message
 *    of that conversation-day (its unit of retrieval).
 *  - Files are written to a temp folder and read by the real files adapter.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppleSourceDeps,
  appleAdapters,
  defaultSourcesConfig,
  filesAdapter,
  SourceIndexer,
  type SqliteSearchIndex,
} from "../src/index.ts";
import type { CorpusDoc } from "./run.ts";

type Obj = Record<string, unknown>;

const OWNER_NAMES = new Set(["jordan", "jordan okafor"]);

export interface IndexedCorpus {
  /** Corpus ids a document id stands for. */
  expand(docId: string): string[];
  /** Documents the source indexers wrote, by source. */
  counts: Record<string, number>;
  /** Index size after (text bytes of source docs, whole file). */
  textBytes: number;
  indexBytes: number;
  cleanup(): void;
}

export async function indexThroughSources(
  index: SqliteSearchIndex,
  corpus: readonly CorpusDoc[],
  now: number,
): Promise<IndexedCorpus> {
  const by = (source: string) => corpus.filter((d) => d.source === source);
  const dayOf = (d: CorpusDoc) => d.createdAt.slice(0, 10);
  const mailRows = by("mail");
  const mailById = new Map(mailRows.map((d) => [d.id, d]));
  const messages = by("imessage").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const groups = new Map<string, string[]>();

  const call = async (tool: string, p: Obj): Promise<unknown> => {
    switch (tool) {
      case "mail_search": {
        let rows = [...mailRows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        if (typeof p.until === "string")
          rows = rows.filter((d) => Date.parse(d.createdAt) < Date.parse(p.until as string));
        if (typeof p.since === "string")
          rows = rows.filter((d) => Date.parse(d.createdAt) > Date.parse(p.since as string));
        return {
          messages: rows
            .slice(0, Number(p.limit ?? 25))
            .map((d) => ({ id: d.id, subject: d.title, from: d.from, date: d.createdAt })),
        };
      }
      case "mail_read":
        return { body: mailById.get(String(p.id))?.text ?? "" };
      case "notes_list":
        return {
          notes: by("notes").map((d) => ({ id: d.id, title: d.title, modified: d.createdAt })),
        };
      case "notes_read":
        return { text: corpus.find((d) => d.id === p.id)?.text ?? "" };
      case "calendar_list_events": {
        const from = Date.parse(String(p.from));
        const to = Date.parse(String(p.to));
        return {
          events: by("calendar")
            .filter((d) => Date.parse(d.createdAt) >= from && Date.parse(d.createdAt) < to)
            .map((d) => ({ id: d.id, title: d.title, start: d.createdAt, notes: d.text })),
        };
      }
      case "reminders_list":
        return {
          reminders:
            p.completed === true
              ? []
              : by("reminders").map((d) => ({
                  id: d.id,
                  title: d.title,
                  notes: d.text,
                  created: d.createdAt,
                })),
        };
      default:
        throw new Error(`no ${tool}`);
    }
  };

  const helper = async (cap: string, p: Obj): Promise<unknown> => {
    if (cap === "messages.graph_chats") {
      const chats = new Map<string, Set<string>>();
      for (const d of messages) {
        const h = chats.get(d.title) ?? new Set<string>();
        for (const name of [d.title]) h.add(name);
        chats.set(d.title, h);
      }
      return {
        chats: [...chats].map(([chatId, h]) => ({ chatId, handles: [...h], isGroup: false })),
      };
    }
    const since = Number(p.sinceCursor ?? 0);
    const limit = Number(p.limit ?? 200);
    const page = messages.slice(since, since + limit);
    return {
      cursor: since + page.length,
      hasMore: since + page.length < messages.length,
      messages: page.map((d) => {
        const out = OWNER_NAMES.has((d.from ?? "").toLowerCase());
        return {
          chatId: d.title,
          handle: out ? undefined : d.from,
          sentAt: d.createdAt,
          direction: out ? "out" : "in",
          text: d.text,
        };
      }),
    };
  };
  // Which corpus messages share a chat-day document: documents are keyed `chat|day|startRow`.
  messages.forEach((d) => {
    const key = `${d.title}|${dayOf(d)}`;
    groups.set(key, [...(groups.get(key) ?? []), d.id]);
  });

  const deps: AppleSourceDeps = {
    call: () => call,
    helper: () => helper,
    ownAddresses: () => [],
    owned: () => true,
    now: () => now,
  };

  const root = mkdtempSync(join(tmpdir(), "psyche-eval-"));
  const pathToId = new Map<string, string>();
  by("files").forEach((d, i) => {
    const dir = join(root, `f${i}`);
    mkdirSync(dir);
    const path = join(dir, `${d.title.replace(/[^\w. -]/g, "_")}.txt`);
    writeFileSync(path, d.text);
    const t = new Date(d.createdAt);
    utimesSync(path, t, t);
    pathToId.set(path, d.id);
  });

  const config = defaultSourcesConfig();
  for (const s of Object.values(config.sources)) s.enabled = true;
  const indexer = new SourceIndexer(
    index,
    [...appleAdapters(deps), filesAdapter({ folders: () => [{ path: root }] })],
    { config: () => config, now: () => now, pauseMs: 0, pagesPerTick: 20, budgetMs: 60_000 },
  );
  for (let i = 0; i < 60; i++) {
    await indexer.tick();
    const st = indexer.status().sources;
    if (st.every((s) => s.backfilled)) break;
  }
  const status = indexer.status();
  const counts = Object.fromEntries(status.sources.map((s) => [s.id, s.items]));
  const textBytes = status.sources.reduce((n, s) => n + s.textBytes, 0);

  return {
    counts,
    textBytes,
    indexBytes: status.indexBytes,
    expand(docId) {
      const m = /^([a-z]+):(.*)$/.exec(docId);
      if (m === null) return [docId];
      const [, src, rest] = m as unknown as [string, string, string];
      if (src === "files") return [pathToId.get(rest) ?? docId];
      if (src === "messages") {
        const [chat, day] = rest.split("|");
        return groups.get(`${chat}|${day}`) ?? [docId];
      }
      return [rest];
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
