import type { MemoryStore, Provenance } from "@psyche/protocol";
import { memoryTitle } from "../memory.ts";
import type { SqliteSearchIndex } from "../sqlite-index.ts";
import type { CardQueue } from "./queue.ts";
import type { CardSource } from "./types.ts";

/** Least-trusted provenance named by the `[owner]` / `[agent]` / `[untrusted:…]` tags of a note. */
export function noteProvenance(content: string): Provenance {
  if (/\[untrusted[\]:]/.test(content)) return "untrusted";
  if (/\[agent\]/.test(content)) return "agent";
  return /\[owner\]/.test(content) ? "owner" : "agent";
}

/**
 * Memory notes are searched through the memory store; this gives each daily note a small index
 * row of its own (id `memory-note:<path>`, title only) so its card can be attached and found.
 * The note text itself is not copied into the index: only the card is searchable.
 */
export async function syncMemoryNotes(
  index: SqliteSearchIndex,
  queue: CardQueue,
  store: Pick<MemoryStore, "listFiles" | "readFile">,
  options: {
    limit?: number;
    now?: () => number;
    dayOf?: (path: string) => number | undefined;
  } = {},
): Promise<number> {
  const files = (await store.listFiles("memory/"))
    .filter((p) => /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(p))
    .sort()
    .reverse()
    .slice(0, options.limit ?? 7);
  let queued = 0;
  for (const path of files) {
    const file = await store.readFile(path);
    if (file === undefined) continue;
    const id = `memory-note:${path}`;
    const day = /(\d{4}-\d{2}-\d{2})/.exec(path)?.[1];
    const createdAt =
      day === undefined ? (options.now ?? Date.now)() : Date.parse(`${day}T12:00:00Z`);
    const item: CardSource = {
      id,
      kind: "memory",
      title: memoryTitle(path),
      text: file.content,
      provenance: noteProvenance(file.content),
      source: "memory",
      createdAt,
    };
    if (!queue.enqueue(item)) continue;
    await index.index({
      id,
      kind: "memory",
      title: item.title,
      text: "",
      provenance: item.provenance,
      createdAt,
      source: "memory-notes",
      parentId: path,
    });
    queued++;
  }
  return queued;
}
