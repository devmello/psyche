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
    const json = JSON.stringify(el);
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
