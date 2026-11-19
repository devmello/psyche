/**
 * Shaping a tool result before the model sees it: pictures become image parts (never base64 text),
 * and an oversized result is cut with a marker that keeps its structure, head and tail.
 * Provenance is not touched here: it rides on the `tool_result` part, so an image from third-party
 * content stays untrusted exactly like text does.
 */
import { imageSize } from "./image-tokens.ts";

export type ImagePart = { type: "image"; mime: string; data: string };
export type TextPart = { type: "text"; text: string };

/** Longest base64 payload sent as one image (Anthropic's 5 MB limit is checked on the base64). */
export const MAX_IMAGE_BASE64_CHARS = 5_242_880;
/** Images one tool result may carry, and their base64 characters in all. */
export const MAX_RESULT_IMAGES = 4;
export const MAX_RESULT_IMAGE_CHARS = 8_000_000;
/** Anthropic rejects an image over 2000 px once a request holds more than 20 images. */
const MAX_IMAGE_EDGE = 2000;
/** Base64 beyond this is refused without decoding it. */
const MAX_DECODE_CHARS = 24_000_000;
/** Tool images kept in a request; older ones become a note (the API takes 100 and 32 MB). */
export const MAX_REQUEST_TOOL_IMAGES = 8;

/** Resizes an image (the Gateway injects `downscaleImage`); returns the bytes to send. */
export type ImageShaper = (bytes: Buffer, mime: string) => Promise<Buffer>;

export interface NormalizeOptions {
  /** The call failed: pictures in an error result are replaced by a note, never sent. */
  failed?: boolean;
  shaper?: ImageShaper;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function declaredMime(o: Record<string, unknown>): unknown {
  return typeof o.mime === "string" ? o.mime : o.mimeType;
}

/** The format the header bytes say (png, jpeg, gif or webp), never the declared mime. */
export function sniffImageMime(b: Uint8Array): string | undefined {
  const ascii = (o: number, t: string) => [...t].every((c, i) => b[o + i] === c.charCodeAt(0));
  let mime: string | undefined;
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, "PNG")) mime = "image/png";
  else if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) mime = "image/jpeg";
  else if (b.length >= 10 && ascii(0, "GIF8")) mime = "image/gif";
  else if (b.length >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) mime = "image/webp";
  return mime !== undefined && imageSize(b) !== undefined ? mime : undefined;
}

const note = (text: string): TextPart => ({ type: "text", text: `[${text}]` });

class ImageBudget {
  count = 0;
  chars = 0;
  readonly o: NormalizeOptions;
  constructor(o: NormalizeOptions) {
    this.o = o;
  }

  async take(data: string): Promise<ImagePart | TextPart> {
    if (this.o.failed === true) return note("image omitted from an error result");
    if (data.length > MAX_DECODE_CHARS) return note("image omitted: larger than the 5 MB limit");
    const head = Buffer.from(data.slice(0, 87_384), "base64");
    let mime = sniffImageMime(head);
    if (mime === undefined) return note("image omitted: not a PNG, JPEG, GIF or WebP image");
    let out = data;
    if (this.o.shaper !== undefined) {
      try {
        const bytes = Buffer.from(data, "base64");
        const sized = await this.o.shaper(bytes, mime);
        if (sized !== bytes) {
          const m = sniffImageMime(sized);
          if (m !== undefined) {
            mime = m;
            out = sized.toString("base64");
          }
        }
      } catch {
        // The original goes on to the limits below.
      }
    }
    if (out.length > MAX_IMAGE_BASE64_CHARS)
      return note("image omitted: larger than the 5 MB limit");
    const size = imageSize(Buffer.from(out.slice(0, 87_384), "base64"));
    if (size === undefined || Math.max(size.width, size.height) > MAX_IMAGE_EDGE)
      return note(`image omitted: longer than ${MAX_IMAGE_EDGE} px on a side`);
    if (this.count >= MAX_RESULT_IMAGES || this.chars + out.length > MAX_RESULT_IMAGE_CHARS)
      return note("image omitted: this result already carries the most images allowed");
    this.count++;
    this.chars += out.length;
    return { type: "image", mime, data: out };
  }
}

const json = (v: unknown): TextPart => ({ type: "text", text: JSON.stringify(v) });

/**
 * Known image result shapes -> `[{type:"image"}, {type:"text"}]` parts:
 * - `{ base64, mime | mimeType, ...metadata }` (browser.screenshot, computer.screenshot);
 * - `{ blocks: [{ type: "image", data, mimeType }, ...], structured? }` (MCP results).
 * Images are checked by their bytes (png, jpeg, gif, webp only), resized by `shaper`, and held to
 * a size, dimension and count budget; one that fails becomes a note. Anything else comes back
 * unchanged.
 */
export async function normalizeToolOutput(
  output: unknown,
  opts: NormalizeOptions = {},
): Promise<unknown> {
  if (!isRecord(output)) return output;
  const budget = new ImageBudget(opts);
  if (typeof output.base64 === "string") {
    const mime = declaredMime(output);
    if (typeof mime !== "string" || !mime.startsWith("image/")) return output;
    const { base64, mime: _m, mimeType: _t, ...rest } = output;
    return [await budget.take(base64), ...(Object.keys(rest).length > 0 ? [json(rest)] : [])];
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
        parts.push(await budget.take(b.data));
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

/**
 * The request's messages with all but the newest `keep` tool-result images replaced by a note, so
 * a long browsing session never reaches the API's image-count and payload limits. The thread is
 * not changed.
 */
export function keepRecentToolImages<M extends { parts: readonly unknown[] }>(
  messages: M[],
  keep: number = MAX_REQUEST_TOOL_IMAGES,
): M[] {
  const outputOf = (p: unknown) =>
    (p as { type?: unknown }).type === "tool_result"
      ? (p as { output?: unknown }).output
      : undefined;
  const imagesOf = (m: M): number =>
    m.parts.reduce<number>((n, p) => {
      const o = outputOf(p);
      return isPartList(o) ? n + o.filter((x) => x.type === "image").length : n;
    }, 0);
  let total = 0;
  for (const m of messages) total += imagesOf(m);
  if (total <= keep) return messages;
  let drop = total - keep;
  return messages.map((m) => {
    if (drop <= 0 || imagesOf(m) === 0) return m;
    return {
      ...m,
      parts: m.parts.map((p) => {
        const o = outputOf(p);
        if (!isPartList(o)) return p;
        return {
          ...(p as object),
          output: o.map((x) => {
            if (x.type !== "image" || drop <= 0) return x;
            drop--;
            return note("earlier screenshot omitted");
          }),
        };
      }),
    };
  });
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
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** A slice end that does not split a surrogate pair. */
const safeEnd = (s: string, i: number) =>
  i > 0 && i < s.length && isHigh(s.charCodeAt(i - 1)) ? i - 1 : i;
/** A slice start that does not split a surrogate pair. */
const safeStart = (s: string, i: number) => (i < s.length && isLow(s.charCodeAt(i)) ? i + 1 : i);

/** Keep the head and the tail of a string, `keep` characters in all, with a marker between. */
export function headTail(text: string, keep: number): string {
  if (text.length <= keep) return text;
  const head = safeEnd(text, Math.ceil(keep * 0.7));
  const tailAt = safeStart(text, text.length - Math.max(0, keep - Math.ceil(keep * 0.7)));
  const omitted = Math.max(0, tailAt - head);
  return `${text.slice(0, head)}\n[truncated: result is ${fmt(text.length)} characters; ${fmt(omitted)} omitted from the middle]\n${text.slice(tailAt)}`;
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
 * `truncated: true` is set. A part list is cut text part by text part, and once the budget is
 * spent the remaining text parts collapse into one marker. Images are not text and are counted
 * by the token estimator, not here. A continuation cursor (`nextOffset`) is dropped from a cut
 * object, as it would point past text the model never received.
 */
export function capToolOutput(output: unknown, max: number): unknown {
  if (isPartList(output)) {
    let left = max;
    let dropped = 0;
    const out: (ImagePart | TextPart)[] = [];
    for (const p of output) {
      if (p.type !== "text") out.push(p);
      else if (left <= 0) dropped++;
      else {
        const text = headTail(p.text, Math.max(MIN_FIELD, left));
        left -= Math.min(p.text.length, Math.max(MIN_FIELD, left));
        out.push(text === p.text ? p : { type: "text", text });
      }
    }
    if (dropped > 0) out.push(note(`truncated: ${fmt(dropped)} more text parts omitted`));
    return out;
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
  const head = safeEnd(first, Math.ceil(max * 0.7));
  const tailAt = safeStart(first, first.length - Math.floor(max * 0.3));
  return `${first.slice(0, head)}\n[truncated: result is ${fmt(first.length)} characters; the middle is omitted]\n${first.slice(tailAt)}`;
}
