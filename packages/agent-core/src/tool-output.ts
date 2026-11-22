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
/**
 * Pixel limits read from the header before anything decodes the image: a small file can claim a
 * huge bitmap (a decompression bomb), and providers refuse over 8000 px anyway.
 */
export const MAX_IMAGE_SIDE_PX = 8000;
export const MAX_IMAGE_PIXELS = 40_000_000;
/**
 * Tool images in a thread: past `TOOL_IMAGES_HIGH` (or `TOOL_IMAGE_CHARS_HIGH` of base64) the
 * thread is cut back to the newest `TOOL_IMAGES_LOW` (within `TOOL_IMAGE_CHARS_LOW`), older ones
 * become a note. Cutting in batches keeps the prompt-cache prefix byte-stable for several steps
 * instead of rewriting it on every new screenshot (the API takes 100 images and 32 MB).
 */
export const TOOL_IMAGES_HIGH = 12;
export const TOOL_IMAGES_LOW = 4;
const TOOL_IMAGE_CHARS_HIGH = 24_000_000;
const TOOL_IMAGE_CHARS_LOW = 16_000_000;

/**
 * Decodes and re-encodes an image, resized to the provider's 1568 px (the Gateway injects
 * `reencodeToolImage`). It must return new bytes and throw when it cannot read the image: the
 * original bytes are never sent. Without a shaper, tool images become a note. `signal` is the
 * run's: a shaper may drop a call still waiting for a decoder once it aborts. It throws
 * `ImageShaperBusy` when too many images already wait, and the image becomes a "busy" note.
 */
export type ImageShaper = (bytes: Buffer, mime: string, signal?: AbortSignal) => Promise<Buffer>;

/** Thrown by a shaper that refuses to queue another image (its decoders are all taken). */
export class ImageShaperBusy extends Error {
  constructor() {
    super("too many images are waiting to be decoded");
    this.name = "ImageShaperBusy";
  }
}

export interface NormalizeOptions {
  /** The call failed: pictures in an error result are replaced by a note, never sent. */
  failed?: boolean;
  shaper?: ImageShaper;
  /** The run's signal, handed to the shaper. */
  signal?: AbortSignal;
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

  /**
   * One image from a tool, as base64. Checked in this order, each failure a note: canonical
   * base64; PNG, JPEG, GIF or WebP by its bytes; header dimensions within 8000 px and 40 MP (before
   * anything decodes it); then decoded and re-encoded by the shaper, whose output is checked again
   * and is what goes out (never the original bytes); then the size and count budget.
   */
  async take(data: string): Promise<ImagePart | TextPart> {
    if (this.o.failed === true) return note("image omitted from an error result");
    if (data.length > MAX_DECODE_CHARS) return note("image omitted: larger than the 5 MB limit");
    if (!isCanonicalBase64(data)) return note("image omitted: not valid base64");
    const bytes = Buffer.from(data, "base64");
    // The whole buffer: a camera JPEG's size marker can sit far behind its EXIF and XMP.
    const mime = sniffImageMime(bytes);
    const size = imageSize(bytes);
    if (mime === undefined || size === undefined)
      return note("image omitted: not a PNG, JPEG, GIF or WebP image");
    if (
      size.width > MAX_IMAGE_SIDE_PX ||
      size.height > MAX_IMAGE_SIDE_PX ||
      size.width * size.height > MAX_IMAGE_PIXELS
    )
      return note(`image omitted: larger than ${MAX_IMAGE_SIDE_PX} px or 40 megapixels`);
    if (this.o.shaper === undefined) return note("image omitted: images cannot be checked here");
    let shaped: Buffer;
    try {
      shaped = await this.o.shaper(bytes, mime, this.o.signal);
    } catch (err) {
      if (err instanceof ImageShaperBusy) return note("image omitted: busy");
      return note("image omitted: it could not be read as an image");
    }
    // What a re-encode must produce: other bytes than the input (a shaper that hands back or
    // copies its input decoded nothing), with a readable header of a sendable format, no larger
    // than the input claimed and within the caps.
    const unreadable = note("image omitted: it could not be read as an image");
    if (shaped === bytes || shaped.equals(bytes)) return unreadable;
    const outMime = sniffImageMime(shaped);
    const outSize = imageSize(shaped);
    if (outMime === undefined || outSize === undefined) return unreadable;
    // A decoder that applies EXIF orientation 5-8 hands back width and height swapped.
    const fits = (w: number, h: number) => outSize.width <= w && outSize.height <= h;
    if (
      !(fits(size.width, size.height) || fits(size.height, size.width)) ||
      outSize.width * outSize.height > MAX_IMAGE_PIXELS
    )
      return unreadable;
    const out = shaped.toString("base64");
    if (out.length > MAX_IMAGE_BASE64_CHARS)
      return note("image omitted: larger than the 5 MB limit");
    if (Math.max(outSize.width, outSize.height) > MAX_IMAGE_EDGE)
      return note(`image omitted: longer than ${MAX_IMAGE_EDGE} px on a side`);
    if (this.count >= MAX_RESULT_IMAGES || this.chars + out.length > MAX_RESULT_IMAGE_CHARS)
      return note("image omitted: this result already carries the most images allowed");
    this.count++;
    this.chars += out.length;
    return { type: "image", mime: outMime, data: out };
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Standard, padded base64 with zero padding bits, nothing else: `Buffer.from` would quietly
 * accept base64url, whitespace and junk, and send something other than what was checked.
 */
export function isCanonicalBase64(data: string): boolean {
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) return false;
  const tail = data.slice(-4);
  return Buffer.from(tail, "base64").toString("base64") === tail;
}

/**
 * True for an image part whose data is canonical base64 of the PNG, JPEG, GIF or WebP its mime
 * names (by the bytes). The thread store skips secret masking for such data: it is image bytes,
 * and a mask written into it would corrupt the image.
 */
export function isCheckedImagePart(v: unknown): v is ImagePart {
  if (!isRecord(v) || v.type !== "image" || typeof v.data !== "string") return false;
  if (typeof v.mime !== "string" || !isCanonicalBase64(v.data)) return false;
  return sniffImageMime(Buffer.from(v.data, "base64")) === v.mime;
}

const json = (v: unknown): TextPart => ({ type: "text", text: JSON.stringify(v) });

/**
 * Known image result shapes -> `[{type:"image"}, {type:"text"}]` parts:
 * - `{ base64, mime | mimeType, ...metadata }` (browser.screenshot, computer.screenshot);
 * - `{ blocks: [{ type: "image", data, mimeType }, ...], structured? }` (MCP results).
 * - a list that is already `[{ type: "text" | "image", ... }]` parts.
 * Images are checked by their bytes (png, jpeg, gif, webp only), re-encoded by `shaper`, and held
 * to a size, dimension and count budget; one that fails becomes a note, and so does an image link.
 * Anything else comes back unchanged.
 */
export async function normalizeToolOutput(
  output: unknown,
  opts: NormalizeOptions = {},
): Promise<unknown> {
  if (Array.isArray(output)) return normalizePartList(output, new ImageBudget(opts));
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

/**
 * A raw part list gets the same image checks as any other shape: an image with base64 `data` goes
 * through the budget, an image link becomes a note, and an image-typed object of another form
 * (a Notion-style block) goes along as JSON text. Other lists come back unchanged.
 */
async function normalizePartList(output: unknown[], budget: ImageBudget): Promise<unknown> {
  if (!looksLikePartList(output)) return output;
  const parts: (ImagePart | TextPart)[] = [];
  for (const p of output as Record<string, unknown>[]) {
    if (p.type === "text")
      parts.push(typeof p.text === "string" ? { type: "text", text: p.text } : json(p));
    else if (typeof p.data === "string") parts.push(await budget.take(p.data));
    else if (typeof p.url === "string")
      parts.push(note("image omitted: a tool result cannot send an image link"));
    else parts.push(json(p));
  }
  return parts;
}

const looksLikePartList = (v: unknown[]): boolean =>
  v.length > 0 && v.every((p) => isRecord(p) && (p.type === "text" || p.type === "image"));

/** True for a list of text / image parts, the form `normalizeToolOutput` produces. */
export function isPartList(v: unknown): v is (ImagePart | TextPart)[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((p) => isRecord(p) && (p.type === "text" || p.type === "image"))
  );
}

/** A message's parts; none for a malformed one (an old or hand-edited saved thread). */
const partsOf = (m: { parts: readonly unknown[] }): readonly unknown[] =>
  Array.isArray(m.parts) ? m.parts : [];

const outputOf = (p: unknown) => (isRecord(p) && p.type === "tool_result" ? p.output : undefined);

/**
 * Tool-result images in a thread, with hysteresis: while there are at most `TOOL_IMAGES_HIGH`
 * (and at most 24M base64 characters) nothing changes; past that, all but the newest
 * `TOOL_IMAGES_LOW` (within 16M characters) become a note. So a long browsing session stays
 * within the API's image-count and payload limits, the thread (and what is saved of it) stays
 * small, and the cached prompt prefix is rewritten once every several screenshots rather than on
 * every one. Returns `messages` itself when nothing changes; otherwise a new array that shares
 * every message it did not touch. Images the owner attached to their own messages are kept.
 */
export function keepRecentToolImages<M extends { parts: readonly unknown[] }>(messages: M[]): M[] {
  const sizes: number[] = [];
  for (const m of messages)
    for (const p of partsOf(m)) {
      const o = outputOf(p);
      if (!isPartList(o)) continue;
      for (const x of o) if (x.type === "image") sizes.push(String(x.data ?? "").length);
    }
  const chars = sizes.reduce((a, b) => a + b, 0);
  if (sizes.length <= TOOL_IMAGES_HIGH && chars <= TOOL_IMAGE_CHARS_HIGH) return messages;
  // The newest images that fit the low marks are kept, the rest (all older ones) noted.
  let kept = 0;
  let keptChars = 0;
  let keepFrom = sizes.length;
  for (let i = sizes.length - 1; i >= 0; i--) {
    const len = sizes[i] ?? 0;
    if (kept >= TOOL_IMAGES_LOW || keptChars + len > TOOL_IMAGE_CHARS_LOW) break;
    kept++;
    keptChars += len;
    keepFrom = i;
  }
  let index = 0;
  return messages.map((m) => {
    if (index >= keepFrom || !Array.isArray(m.parts)) return m;
    let changed = false;
    const parts = m.parts.map((p) => {
      const o = outputOf(p);
      if (!isPartList(o) || !o.some((x) => x.type === "image")) return p;
      changed = true;
      return {
        ...(p as object),
        output: o.map((x) => {
          if (x.type !== "image") return x;
          return index++ < keepFrom ? note("earlier screenshot omitted") : x;
        }),
      };
    });
    return changed ? { ...m, parts } : m;
  });
}

/** JSON.stringify replacer that writes any image object as `"[image]"` (as the CLI prompt does). */
export function imagePlaceholder(_key: string, v: unknown): unknown {
  return v !== null && typeof v === "object" && (v as { type?: unknown }).type === "image"
    ? "[image]"
    : v;
}

/** A tool output as text with no picture data: a part list as its lines, anything else as JSON. */
export function outputAsText(output: unknown): string {
  if (isPartList(output))
    return output.map((p) => (p.type === "image" ? "[image]" : p.text)).join("\n");
  try {
    return JSON.stringify(output, imagePlaceholder) ?? "";
  } catch {
    return String(output);
  }
}

/**
 * Providers' own wording for a request refused over an image's bytes:
 * - Anthropic: "Could not process image", "image exceeds 5 MB maximum", "image dimensions exceed
 *   max allowed size", "Image does not match the provided media type", "…appears to be a
 *   image/jpeg image", a `messages.N.content.M.image.source…` path;
 * - OpenAI: "Invalid image", "You uploaded an unsupported image", "does not represent a valid
 *   image", `invalid_image` / `invalid_image_format` / `image_parse_error` codes;
 * - Google: "Unable to process input image", "Provided image is not valid".
 * Not a mention of the word: a tool named `image_search`, a model id `gpt-image-1` or "this
 * model does not support image input" do not count.
 */
const IMAGE_REJECTION =
  /could not process (?:the )?image|unable to process (?:the )?(?:input )?image|\binvalid[ _]image(?:_format)?\b|unsupported image\b|\bimage exceeds\b|image dimensions exceed|image does not match the provided media type|appears to be an? image\/|provided image is not valid|does not represent a valid image|\bimage_parse_error\b|\.image\.source\b/i;

/** True for a model call's error that is a provider's 400 refusing an image (`bad_request: …`). */
export function isImageRejection(error: string): boolean {
  return error.startsWith("bad_request:") && IMAGE_REJECTION.test(error);
}

/** Every tool-result image replaced by `text` as a note; `messages` itself when there is none. */
export function withoutToolImages<M extends { parts: readonly unknown[] }>(
  messages: M[],
  text: string,
): M[] {
  let changed = false;
  const out = messages.map((m) => {
    if (!Array.isArray(m.parts)) return m;
    let touched = false;
    const parts = m.parts.map((p) => {
      const o = outputOf(p);
      if (!isPartList(o) || !o.some((x) => x.type === "image")) return p;
      touched = true;
      return { ...(p as object), output: o.map((x) => (x.type === "image" ? note(text) : x)) };
    });
    if (!touched) return m;
    changed = true;
    return { ...m, parts };
  });
  return changed ? out : messages;
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
export const safeEnd = (s: string, i: number) =>
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
