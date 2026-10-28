import type { ModelMessage } from "@psyche/protocol";
import { estimateTokens } from "./util.ts";

/** Longest edge providers resize to before reading an image (Anthropic: 1568 px). */
export const IMAGE_MAX_EDGE = 1568;
/** Anthropic's per-image ceiling, ~ (1568 x 1568) / 750 after resizing. */
const IMAGE_MAX_TOKENS = 1_600;
/** Charged when the size cannot be read (a URL, an odd format): a typical screenshot. */
export const IMAGE_FALLBACK_TOKENS = 1_500;

export interface ImageSize {
  width: number;
  height: number;
}

/** Width and height from the image header (PNG, JPEG, GIF, WebP); undefined when unreadable. */
export function imageSize(bytes: Uint8Array): ImageSize | undefined {
  const b = bytes;
  const u16be = (o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
  const u32be = (o: number) => u16be(o) * 65536 + u16be(o + 2);
  const u16le = (o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
  const u24le = (o: number) => u16le(o) | ((b[o + 2] ?? 0) << 16);
  const ascii = (o: number, s: string) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  let size: ImageSize | undefined;
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, "PNG")) {
    size = { width: u32be(16), height: u32be(20) };
  } else if (b.length >= 10 && ascii(0, "GIF8")) {
    size = { width: u16le(6), height: u16le(8) };
  } else if (b.length >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8X")) size = { width: u24le(24) + 1, height: u24le(27) + 1 };
    else if (ascii(12, "VP8L"))
      size = {
        width: (u16le(21) & 0x3fff) + 1,
        height: (((u16le(22) >> 6) | ((b[24] ?? 0) << 2)) & 0x3fff) + 1,
      };
    else if (ascii(12, "VP8 ")) size = { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
  } else if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1] ?? 0;
      if (marker === 0xff) {
        o++;
        continue;
      }
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        size = { height: u16be(o + 5), width: u16be(o + 7) };
        break;
      }
      o += 2 + u16be(o + 2);
    }
  }
  return size !== undefined && size.width > 0 && size.height > 0 ? size : undefined;
}

/** Tokens one image costs: about width x height / 750 after the long edge is cut to 1568 px. */
export function imageTokensForSize({ width, height }: ImageSize): number {
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(width, height));
  const tokens = Math.ceil((width * scale * (height * scale)) / 750);
  return Math.max(1, Math.min(IMAGE_MAX_TOKENS, tokens));
}

/** Tokens for an image part, by its dimensions (never by the length of its base64). */
export function estimateImageTokens(part: { data?: string; url?: string }): number {
  if (part.data === undefined) return IMAGE_FALLBACK_TOKENS;
  try {
    // The header is in the first bytes, but JPEG's size marker can sit after EXIF: take 64 KB.
    const head = Buffer.from(part.data.slice(0, 87_384), "base64");
    const size = imageSize(head);
    return size === undefined ? IMAGE_FALLBACK_TOKENS : imageTokensForSize(size);
  } catch {
    return IMAGE_FALLBACK_TOKENS;
  }
}

function stripImages(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && (value as { type?: unknown }).type === "image")
    return { type: "image" };
  return value;
}

/** Tokens for a transcript: images by size, everything else by its JSON text. */
export function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
  let images = 0;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.type === "image" && (typeof o.data === "string" || typeof o.url === "string")) {
      images += estimateImageTokens({
        ...(typeof o.data === "string" ? { data: o.data } : {}),
        ...(typeof o.url === "string" ? { url: o.url } : {}),
      });
      return;
    }
    for (const x of Object.values(o)) visit(x);
  };
  visit(messages);
  return estimateTokens(JSON.stringify(messages, stripImages)) + images;
}
