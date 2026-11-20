/**
 * Splits a conversations export into batches the Gateway can take. A WebSocket frame is 1 MiB,
 * so each batch holds whole conversations and stays under the character and byte caps (the
 * schema caps characters; bytes cover multi-byte text). A conversation too big for one batch is
 * skipped and reported, never cut.
 */

export const BATCH_CHARS = 330_000;
export const BATCH_BYTES = 900_000;
/** Largest export file read into memory (a JSON string over ~500 MB cannot be parsed). */
export const MAX_EXPORT_BYTES = 400 * 1024 * 1024;
/** Conversations taken from one export in one import. */
export const MAX_EXPORT_CONVERSATIONS = 20_000;

export interface SplitResult {
  batches: string[];
  /** Conversations that could not be sent. */
  skipped: { title: string; reason: "too_many" | "too_large" | "invalid" }[];
  /** Conversations in the batches. */
  count: number;
}

const encoder = new TextEncoder();
const TEXT_CAP = 20_000;

const isRec = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const cap = (s: string): string =>
  s.length <= TEXT_CAP ? s : `${s.slice(0, TEXT_CAP - 20)}\n[truncated]`;

/**
 * Keeps only what the Gateway's parser reads, so abandoned branches, tool nodes and metadata do
 * not make a long conversation look too big for a batch.
 */
export function trimEntry(el: unknown): unknown {
  if (!isRec(el)) return el;
  const out: Record<string, unknown> = {};
  for (const k of ["uuid", "id", "conversation_id", "name", "title"]) {
    if (typeof el[k] === "string") out[k] = (el[k] as string).slice(0, 400);
  }
  for (const k of ["created_at", "updated_at", "create_time", "update_time"]) {
    if (typeof el[k] === "string" || typeof el[k] === "number") out[k] = el[k];
  }
  if (Array.isArray(el.chat_messages)) {
    out.chat_messages = el.chat_messages.flatMap((m: unknown) => {
      if (!isRec(m)) return [];
      let text = typeof m.text === "string" ? m.text : "";
      if (Array.isArray(m.content)) {
        const parts = m.content.flatMap((c: unknown) =>
          isRec(c) && c.type === "text" && typeof c.text === "string" ? [c.text] : [],
        );
        if (parts.length > 0) text = parts.join("\n\n");
      }
      return [{ sender: m.sender, created_at: m.created_at, text: cap(text) }];
    });
  }
  if (isRec(el.mapping)) {
    const mapping = el.mapping;
    let id: string | undefined = typeof el.current_node === "string" ? el.current_node : undefined;
    if (id === undefined || !isRec(mapping[id])) {
      id = Object.keys(mapping).find((k) => {
        const n = mapping[k];
        return isRec(n) && Array.isArray(n.children) && n.children.length === 0;
      });
    }
    const kept: Record<string, unknown> = {};
    const seen = new Set<string>();
    out.current_node = id;
    while (id !== undefined && !seen.has(id) && seen.size < 5_000) {
      seen.add(id);
      const node = mapping[id];
      if (!isRec(node)) break;
      const msg = isRec(node.message) ? node.message : undefined;
      const parts =
        msg && isRec(msg.content) && Array.isArray(msg.content.parts)
          ? msg.content.parts.filter((p: unknown): p is string => typeof p === "string").map(cap)
          : [];
      kept[id] = {
        parent: node.parent,
        children: [],
        message: msg
          ? {
              author: { role: isRec(msg.author) ? msg.author.role : undefined },
              content: { content_type: "text", parts },
              create_time: msg.create_time,
            }
          : null,
      };
      id = typeof node.parent === "string" ? node.parent : undefined;
    }
    out.mapping = kept;
  }
  return out;
}

function titleOf(el: unknown): string {
  if (el === null || typeof el !== "object") return "";
  const o = el as Record<string, unknown>;
  const t = o.name ?? o.title;
  return typeof t === "string" ? t.slice(0, 120) : "";
}

export function splitExport(text: string): SplitResult {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("not a conversations export");
  const batches: string[] = [];
  const skipped: SplitResult["skipped"] = [];
  let current: string[] = [];
  let chars = 2;
  let bytes = 2;
  let count = 0;
  const flush = () => {
    if (current.length > 0) batches.push(`[${current.join(",")}]`);
    current = [];
    chars = 2;
    bytes = 2;
  };
  for (const el of parsed) {
    if (count >= MAX_EXPORT_CONVERSATIONS) {
      skipped.push({ title: titleOf(el), reason: "too_many" });
      continue;
    }
    const json = JSON.stringify(trimEntry(el));
    if (json === undefined || el === null || typeof el !== "object") {
      skipped.push({ title: "", reason: "invalid" });
      continue;
    }
    const b = encoder.encode(json).length;
    if (json.length + 2 > BATCH_CHARS || b + 2 > BATCH_BYTES) {
      skipped.push({ title: titleOf(el), reason: "too_large" });
      continue;
    }
    if (chars + json.length + 1 > BATCH_CHARS || bytes + b + 1 > BATCH_BYTES) flush();
    current.push(json);
    chars += json.length + 1;
    bytes += b + 1;
    count += 1;
  }
  flush();
  return { batches, skipped, count };
}
