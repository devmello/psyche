/**
 * Shaping a tool result before the model sees it: pictures become image parts (never base64 text),
 * and an oversized result is cut with a marker that keeps its structure, head and tail.
 * Provenance is not touched here: it rides on the `tool_result` part, so an image from third-party
 * content stays untrusted exactly like text does.
 */

export type ImagePart = { type: "image"; mime: string; data: string };
export type TextPart = { type: "text"; text: string };

/** Longest base64 payload sent as one image (Anthropic refuses images over 5 MB). */
export const MAX_IMAGE_BASE64_CHARS = 7_000_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mimeOf(o: Record<string, unknown>): string | undefined {
  const m = typeof o.mime === "string" ? o.mime : o.mimeType;
  return typeof m === "string" && m.startsWith("image/") ? m : undefined;
}

function imageOrNote(mime: string, data: string): ImagePart | TextPart {
  if (data.length > MAX_IMAGE_BASE64_CHARS)
    return {
      type: "text",
      text: `[image omitted: ${mime}, ${Math.round((data.length * 3) / 4 / 1024).toLocaleString("en-US")} KiB is larger than the 5 MB limit]`,
    };
  return { type: "image", mime, data };
}

const json = (v: unknown): TextPart => ({ type: "text", text: JSON.stringify(v) });

/**
 * Known image result shapes -> `[{type:"image"}, {type:"text"}]` parts:
 * - `{ base64, mime | mimeType, ...metadata }` (browser.screenshot, computer.screenshot);
 * - `{ blocks: [{ type: "image", data, mimeType }, ...], structured? }` (MCP results).
 * Anything else comes back unchanged.
 */
export function normalizeToolOutput(output: unknown): unknown {
  if (!isRecord(output)) return output;
  if (typeof output.base64 === "string") {
    const mime = mimeOf(output);
    if (mime === undefined) return output;
    const { base64, mime: _m, mimeType: _t, ...rest } = output;
    return [imageOrNote(mime, base64), ...(Object.keys(rest).length > 0 ? [json(rest)] : [])];
  }
  if (Array.isArray(output.blocks)) {
    const blocks = output.blocks as unknown[];
    const hasImage = blocks.some(
      (b) => isRecord(b) && b.type === "image" && typeof b.data === "string",
    );
    if (!hasImage) return output;
    const parts: (ImagePart | TextPart)[] = [];
    for (const b of blocks) {
      if (isRecord(b) && b.type === "text" && typeof b.text === "string")
        parts.push({ type: "text", text: b.text });
      else if (isRecord(b) && b.type === "image" && typeof b.data === "string")
        parts.push(imageOrNote(mimeOf(b) ?? "image/png", b.data));
      else parts.push(json(b));
    }
    const { blocks: _b, ...rest } = output;
    if (Object.keys(rest).length > 0) parts.push(json(rest));
    return parts;
  }
  return output;
}

/** True for a list of text / image parts, the form `normalizeToolOutput` produces. */
export function isPartList(v: unknown): v is (ImagePart | TextPart)[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((p) => isRecord(p) && (p.type === "text" || p.type === "image"))
  );
}

/** Pictures replaced by a note, for a model that cannot read images. */
export function withoutImages(parts: (ImagePart | TextPart)[], model: string): TextPart[] {
  return parts.map((p) =>
    p.type === "image"
      ? {
          type: "text" as const,
          text: `[image not shown: ${model} cannot read images. Tell the owner, and suggest switching to a model that can see images.]`,
        }
      : p,
  );
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** Keep the head and the tail of a string, `keep` characters in all, with a marker between. */
export function headTail(text: string, keep: number): string {
  if (text.length <= keep) return text;
  const head = Math.ceil(keep * 0.7);
  const tail = Math.max(0, keep - head);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[truncated: result is ${fmt(text.length)} characters; ${fmt(omitted)} omitted from the middle]\n${tail > 0 ? text.slice(text.length - tail) : ""}`;
}

type Holder = { parent: Record<string | number, unknown>; key: string | number; len: number };

function largestString(root: unknown): Holder | undefined {
  let best: Holder | undefined;
  const visit = (node: unknown, parent: Holder["parent"], key: string | number): void => {
    if (typeof node === "string") {
      if (best === undefined || node.length > best.len) best = { parent, key, len: node.length };
    } else if (Array.isArray(node)) {
      node.forEach((x, i) => {
        visit(x, node as unknown as Holder["parent"], i);
      });
    } else if (isRecord(node)) {
      for (const [k, x] of Object.entries(node)) visit(x, node, k);
    }
  };
  visit(root, { root }, "root");
  return best;
}

const MIN_FIELD = 256;

/**
 * Cap a result at `max` characters. Strings keep head and tail. An object keeps its shape and its
 * trailing fields: the largest string field is shortened (head and tail) until it fits, and
 * `truncated: true` is set. Images are not text and are counted by the token estimator, not here.
 * A continuation cursor (`nextOffset`) is dropped from a cut object, as it would point past text
 * the model never received.
 */
export function capToolOutput(output: unknown, max: number): unknown {
  if (isPartList(output)) {
    let left = max;
    return output.map((p) => {
      if (p.type !== "text") return p;
      const text = headTail(p.text, Math.max(MIN_FIELD, left));
      left = Math.max(0, left - p.text.length);
      return text === p.text ? p : { type: "text" as const, text };
    });
  }
  if (typeof output === "string") return headTail(output, max);
  const first = JSON.stringify(output ?? null);
  if (first.length <= max) return output;
  if (isRecord(output) || Array.isArray(output)) {
    const copy = structuredClone(output) as Record<string, unknown> | unknown[];
    for (let i = 0; i < 64; i++) {
      const len = JSON.stringify(copy).length;
      if (len <= max) {
        if (!Array.isArray(copy)) {
          copy.truncated = true;
          delete copy.nextOffset;
        }
        return copy;
      }
      const best = largestString(copy);
      if (best === undefined || best.len <= MIN_FIELD) break;
      const target = Math.max(MIN_FIELD, best.len - (len - max) - 160);
      best.parent[best.key] = headTail(String(best.parent[best.key]), target);
    }
  }
  return `${first.slice(0, Math.ceil(max * 0.7))}\n[truncated: result is ${fmt(first.length)} characters; the middle is omitted]\n${first.slice(first.length - Math.floor(max * 0.3))}`;
}
