import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { getLibraryItem, getThread, listAllMessages, type PsycheDb } from "@psyche/db";
import type { FeedPost, Goal, Idea, LibraryItem, Task, TaskAction } from "@psyche/protocol";
import {
  type BackfillPage,
  type BackfillSource,
  feedDoc,
  goalDoc,
  hasAttachment,
  ideaDoc,
  isIncognito,
  libraryDoc,
  messageDoc,
  type SearchDoc,
  taskActionDoc,
  taskDoc,
  threadDoc,
  threadScope,
} from "@psyche/search";
import { libraryRoot } from "./library.ts";

/**
 * Backfill sources over the Gateway's stores (docs/design/search-2026.md §5.1). Rows are paged by
 * id (stable while new rows arrive; the live indexer covers those). Incognito threads and
 * everything under them are skipped, like the indexer does.
 */
export interface SearchSourceDeps {
  db: PsycheDb;
  home: string;
  tasks: {
    get(taskId: string): Promise<Task | undefined>;
    actions(taskId: string): Promise<TaskAction[]>;
  };
  feed?: {
    list(f: { cursor?: string; limit?: number }): Promise<{
      posts: FeedPost[];
      nextCursor: string | null;
    }>;
  };
  ideas?: {
    list(p: { status?: readonly Idea["status"][]; cursor?: string; limit?: number }): Promise<{
      ideas: Idea[];
      nextCursor: string | null;
    }>;
  };
  goals?: { list(f: { status?: readonly Goal["status"][] }): Promise<Goal[]> };
  /** Rows per page (default 200). */
  pageSize?: number;
}

/** Text files up to this size are indexed whole (capped by the index's body limit). */
const MAX_TEXT_BYTES = 1024 * 1024;
const TEXT_MIME = /^text\/|json|xml|yaml|toml|markdown/;

const IDEA_STATUSES: Idea["status"][] = ["proposed", "accepted", "edited", "dismissed", "expired"];
const GOAL_STATUSES: Goal["status"][] = ["candidate", "active", "paused", "done", "archived"];

export function searchSources(deps: SearchSourceDeps): BackfillSource[] {
  const { db } = deps;
  const size = deps.pageSize ?? 200;
  const idsAfter = (table: string, cursor: string | null): string[] =>
    (
      db.sqlite
        .prepare(`SELECT id FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`)
        .all(cursor ?? "", size) as { id: string }[]
    ).map((r) => r.id);
  const nextOf = (ids: string[]) => (ids.length < size ? null : (ids.at(-1) ?? null));

  const threads: BackfillSource = {
    name: "threads",
    kinds: ["thread"],
    async page(cursor) {
      const ids = idsAfter("threads", cursor);
      const docs: SearchDoc[] = [];
      for (const id of ids) {
        const t = getThread(db, id);
        if (t !== undefined && !isIncognito(t)) docs.push(threadDoc(t));
      }
      return { docs, next: nextOf(ids) };
    },
  };

  // One page = the messages of up to `size / 10` threads (threads can be long).
  const messages: BackfillSource = {
    name: "messages",
    kinds: ["message"],
    async page(cursor) {
      const ids = (
        db.sqlite
          .prepare("SELECT id FROM threads WHERE id > ? ORDER BY id LIMIT ?")
          .all(cursor ?? "", Math.max(1, Math.floor(size / 10))) as { id: string }[]
      ).map((r) => r.id);
      const out: BackfillPage = { docs: [], flags: [], next: null };
      for (const id of ids) {
        const thread = getThread(db, id);
        if (thread === undefined || isIncognito(thread)) continue;
        for (const m of listAllMessages(db, id)) {
          out.docs.push(messageDoc(m, { thread }));
          if (hasAttachment(m)) {
            out.flags?.push({ targetId: m.id, flag: "attachment" });
            out.flags?.push({ targetId: id, flag: "attachment" });
          }
        }
      }
      out.next = ids.length < Math.max(1, Math.floor(size / 10)) ? null : (ids.at(-1) ?? null);
      return out;
    },
  };

  const tasks: BackfillSource = {
    name: "tasks",
    kinds: ["task"],
    async page(cursor) {
      const ids = idsAfter("tasks", cursor);
      const docs: SearchDoc[] = [];
      for (const id of ids) {
        const task = await deps.tasks.get(id);
        if (task === undefined) continue;
        const thread = getThread(db, task.threadId);
        if (thread === undefined || isIncognito(thread)) continue;
        docs.push(taskDoc(task, thread));
        for (const a of await deps.tasks.actions(id))
          docs.push(taskActionDoc(a, task, threadScope(thread)));
      }
      return { docs, next: nextOf(ids) };
    },
  };

  const library: BackfillSource = {
    name: "library",
    kinds: ["library"],
    async page(cursor) {
      const ids = idsAfter("library_items", cursor);
      const docs: SearchDoc[] = [];
      for (const id of ids) {
        const item = getLibraryItem(db, id);
        if (item !== undefined) docs.push(libraryDoc(item, await libraryText(deps.home, item)));
      }
      return { docs, next: nextOf(ids) };
    },
  };

  const sources = [threads, messages, tasks, library];
  const { feed, ideas, goals } = deps;
  if (feed !== undefined)
    sources.push({
      name: "feed",
      kinds: ["feed"],
      async page(cursor) {
        const res = await feed.list({ ...(cursor === null ? {} : { cursor }), limit: size });
        return { docs: res.posts.map(feedDoc), next: res.nextCursor };
      },
    });
  if (ideas !== undefined)
    sources.push({
      name: "ideas",
      kinds: ["idea"],
      async page(cursor) {
        const res = await ideas.list({
          status: IDEA_STATUSES,
          ...(cursor === null ? {} : { cursor }),
          limit: size,
        });
        return { docs: res.ideas.map(ideaDoc), next: res.nextCursor };
      },
    });
  if (goals !== undefined)
    sources.push({
      name: "goals",
      kinds: ["goal"],
      async page() {
        return { docs: (await goals.list({ status: GOAL_STATUSES })).map(goalDoc), next: null };
      },
    });
  return sources;
}

/**
 * Searchable text of a Library item: its stored text extract, else the file itself when it is
 * small text. Quarantined items (untrusted downloads) are indexed by name and tags only, so the
 * index never parses a file the owner has not released.
 */
export async function libraryText(home: string, item: LibraryItem): Promise<string> {
  if (item.quarantined === true) return "";
  const root = libraryRoot(home);
  const inside = (rel: string) => {
    if (isAbsolute(rel)) return undefined;
    const abs = normalize(join(root, rel));
    return abs.startsWith(root + sep) ? abs : undefined;
  };
  try {
    if (item.textExtractRef != null) {
      const abs = inside(item.textExtractRef);
      if (abs !== undefined) return await readFile(abs, "utf8");
    }
    if (TEXT_MIME.test(item.mime)) {
      const abs = inside(item.path);
      if (abs !== undefined && (await stat(abs)).size <= MAX_TEXT_BYTES)
        return await readFile(abs, "utf8");
    }
  } catch {
    // A missing or unreadable file is indexed by name.
  }
  return "";
}
