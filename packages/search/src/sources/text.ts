import { createHash } from "node:crypto";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Drops quoted replies from a mail body (`>` lines, "On … wrote:" and what follows, Outlook
 * "From:/Sent:" headers, "-----Original Message-----"), so a long thread is not stored once per
 * reply. Falls back to the whole text when stripping would leave nothing.
 */
export function stripQuotedReplies(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const keep: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*-{2,}\s*(original message|forwarded message)\s*-{2,}\s*$/i.test(line)) break;
    if (/^\s*on .{5,200}wrote:\s*$/i.test(line)) break;
    if (/^\s*on .{5,200}$/i.test(line) && /wrote:\s*$/i.test(lines[i + 1] ?? "")) break;
    if (
      /^\s*from:\s.+/i.test(line) &&
      /^\s*(sent|date):\s/i.test(lines[i + 1] ?? "") &&
      keep.length > 0
    )
      break;
    if (/^\s*>/.test(line)) continue;
    keep.push(line);
  }
  const out = keep.join("\n").trim();
  return out === "" ? body.trim() : out;
}

/*
 * Visible-text rendering of HTML (the same scanner as packages/memory/src/extraction/clean.ts,
 * which is what the everything-memory reader runs over indexed text). Text a reader cannot see
 * (display:none, zero size, white or transparent colour, off-screen, aria-hidden, comments,
 * scripts and styles) is dropped here too, so it never enters the index as ordinary text.
 */
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
function renderVisibleHtml(html: string): { text: string; hidden: boolean } {
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

/** Plain text of a note's HTML body, for notes that arrive without a plain-text field. */
export function htmlToText(html: string): string {
  return renderVisibleHtml(html)
    .text.replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
