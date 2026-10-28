/**
 * Stage 1 of the extraction pipeline (docs/design/everything-memory-2026.md §5.1): turn a raw
 * item into the plain, visible text a model may see. Deterministic, no model. The cleaned text is
 * the reference every citation is checked against.
 *
 * Removes what a human reader would not see (hidden elements, comments, zero-width and bidi
 * control characters), renders HTML to visible text, drops quoted replies, and caps the length.
 * What it removed is reported, because hidden text is itself a quarantine reason (§5.6).
 */

export const MAX_ITEM_CHARS = 6000;

export interface CleanedText {
  text: string;
  /** Hidden elements, comments, or invisible/bidi characters inside words were removed. */
  hiddenRemoved: boolean;
  /** The input was cut at `MAX_ITEM_CHARS`. */
  truncated: boolean;
  /** Characters of the raw input that were scanned (the input, bounded). */
  rawLength: number;
  /** Characters of visible text before the final cut to `MAX_ITEM_CHARS`. */
  visibleLength: number;
}

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "wbr"]);
const ALWAYS_DROPPED = new Set(["script", "style", "head", "title", "noscript", "template", "svg"]);
const BLOCK = new Set([
  "p",
  "div",
  "br",
  "li",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "table",
  "ul",
  "ol",
  "pre",
  "section",
  "article",
]);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k] as string;
    if (k.startsWith("#x")) return safeCodePoint(Number.parseInt(k.slice(2), 16), m);
    if (k.startsWith("#")) return safeCodePoint(Number.parseInt(k.slice(1), 10), m);
    return m;
  });
}

function safeCodePoint(n: number, fallback: string): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}

/** Colour values a reader cannot see against a page: white-ish, transparent. */
function invisibleColor(v: string): boolean {
  const c = v.trim().toLowerCase().replace(/\s+/g, "");
  return (
    c === "white" ||
    c === "transparent" ||
    /^#(?:f{3}|f{6}|f{8})$/.test(c) ||
    /^rgba?\(255,255,255(?:,(?:1|1\.0+))?\)$/.test(c) ||
    /^rgba\([^)]*,0(?:\.0+)?\)$/.test(c)
  );
}

function hiddenByAttributes(attrs: string): boolean {
  const a = attrs.toLowerCase();
  if (/\bhidden(?:\s|=|$)/.test(a) || /aria-hidden\s*=\s*["']?true/.test(a)) return true;
  const style = /style\s*=\s*"([^"]*)"|style\s*=\s*'([^']*)'/.exec(a);
  if (style === null) return false;
  const css = (style[1] ?? style[2] ?? "").replace(/\s+/g, "");
  if (
    /display:none|visibility:hidden|opacity:0(?:\.0+)?(?:;|$)|(?:^|;)font-size:0(?:px|pt|em|rem|%)?(?:;|$)/.test(
      css,
    )
  ) {
    return true;
  }
  if (/(?:max-)?(?:height|width):0(?:px)?(?:;|$)[\s\S]*overflow:hidden/.test(css)) return true;
  if (/text-indent:-\d{3,}/.test(css) || /(?:left|top):-\d{4,}px/.test(css)) return true;
  const color = /(?:^|;)color:([^;]+)/.exec(css);
  return color !== null && invisibleColor(color[1] as string);
}

/** Index of the `>` that ends the tag starting before `from`, skipping quoted attribute values. */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let k = from; k < html.length; k++) {
    const c = html[k] as string;
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return k;
    }
  }
  return -1;
}

/** A tiny tag scanner: enough to drop hidden subtrees and render the rest as text. */
function htmlToText(html: string): { text: string; hidden: boolean } {
  let hidden = false;
  let out = "";
  const stack: { name: string; hide: boolean }[] = [];
  let hideDepth = 0;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      if (hideDepth === 0) out += html.slice(i);
      break;
    }
    if (hideDepth === 0) out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      hidden = true;
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const gt = tagEnd(html, lt + 1);
    if (gt < 0) {
      if (hideDepth === 0) out += html.slice(lt);
      break;
    }
    const tag = /^<(\/?)([a-zA-Z][\w:-]*)([\s\S]*?)(\/?)$/.exec(html.slice(lt, gt));
    i = gt + 1;
    if (tag === null) {
      if (hideDepth === 0) out += html.slice(lt, gt + 1);
      continue;
    }
    const closing = tag[1] === "/";
    const name = (tag[2] as string).toLowerCase();
    const attrs = tag[3] as string;
    if (closing) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k]?.name === name) {
          for (const dropped of stack.splice(k)) if (dropped.hide) hideDepth--;
          break;
        }
      }
      if (hideDepth === 0 && BLOCK.has(name)) out += "\n";
      continue;
    }
    if (VOID.has(name) || tag[4] === "/") {
      if (hideDepth === 0 && BLOCK.has(name)) out += "\n";
      continue;
    }
    const hide = ALWAYS_DROPPED.has(name) || hiddenByAttributes(attrs);
    if (hide) {
      hideDepth++;
      if (!ALWAYS_DROPPED.has(name)) hidden = true;
    }
    stack.push({ name, hide });
    if (hideDepth === 0 && BLOCK.has(name)) out += "\n";
  }
  return { text: decodeEntities(out), hidden };
}

const BIDI = /[‪-‮⁦-⁩]/g;
const ZERO_WIDTH = /[​-‍⁠﻿­]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

function stripInvisible(text: string): { text: string; hidden: boolean } {
  let hidden = BIDI.test(text);
  BIDI.lastIndex = 0;
  // A zero-width character inside a word splits it past keyword filters; in emoji it is normal.
  if (/[\p{L}\p{N}][​‌⁠﻿­]+[\p{L}\p{N}]/u.test(text)) hidden = true;
  const cleaned = text
    .replace(BIDI, "")
    .replace(ZERO_WIDTH, (m, off: number, all: string) => {
      // Keep a joiner between emoji; drop it elsewhere.
      const before = Array.from(all.slice(Math.max(0, off - 2), off)).pop() ?? "";
      if (m === "\u200d" && /\p{Extended_Pictographic}/u.test(before)) return m;
      return "";
    })
    .replace(CONTROL, "");
  return { text: cleaned, hidden };
}

/** Drops quoted replies and the "On <date>, X wrote:" tail so old text is not re-read. */
function stripQuotedReply(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (
      /^\s*(?:On .{5,200}wrote:|-{2,}\s*Original Message\s*-{2,}|From:\s.+\bSent:\s)/i.test(line)
    ) {
      break;
    }
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

export interface CleanOptions {
  /** `html` strips markup; `text` is taken as written. */
  format: "html" | "text";
  /** Keep quoted replies (default: strip them). */
  keepQuoted?: boolean;
}

export function cleanItemText(raw: string, opts: CleanOptions): CleanedText {
  // Bound the work before any scanning: a 5 MB mail is cut first.
  const bounded = raw.length > MAX_ITEM_CHARS * 40 ? raw.slice(0, MAX_ITEM_CHARS * 40) : raw;
  const rendered = opts.format === "html" ? htmlToText(bounded) : { text: bounded, hidden: false };
  const invisible = stripInvisible(rendered.text);
  let text = opts.keepQuoted === true ? invisible.text : stripQuotedReply(invisible.text);
  text = text
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const visibleLength = text.length;
  const truncated = text.length > MAX_ITEM_CHARS;
  if (truncated) text = text.slice(0, MAX_ITEM_CHARS);
  return {
    text,
    hiddenRemoved: rendered.hidden || invisible.hidden,
    truncated,
    rawLength: bounded.length,
    visibleLength,
  };
}
