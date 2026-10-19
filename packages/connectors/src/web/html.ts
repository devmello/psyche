import TurndownService from "turndown";

/**
 * HTML → Markdown for model consumption (feature M8). Everything a reader cannot see is dropped
 * before conversion, so hidden-text prompt injections (security §7.4: hidden DOM fields, hidden
 * spans) do not reach the model: scripts, styles, forms, embedded frames and SVG, plus elements
 * marked `hidden`, `aria-hidden="true"` or hidden through inline styles.
 */

/** The slice of the DOM element API the rules use (the package is built without lib.dom). */
interface ElementLike {
  nodeName: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

const DROPPED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "IFRAME",
  "FRAME",
  "FRAMESET",
  "OBJECT",
  "EMBED",
  "APPLET",
  "SVG",
  "MATH",
  "CANVAS",
  "FORM",
  "INPUT",
  "BUTTON",
  "SELECT",
  "OPTION",
  "TEXTAREA",
  "LABEL",
  "DIALOG",
  "HEAD",
  "TITLE",
  "META",
  "LINK",
  "BASE",
]);

const HIDDEN_STYLE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\.0*)?\s*(?:!important)?\s*(?:;|$)|font-size\s*:\s*0(?:px|em|rem|pt|%)?\s*(?:!important)?\s*(?:;|$)|content-visibility\s*:\s*hidden)/i;

export function isHiddenElement(el: ElementLike): boolean {
  if (DROPPED_TAGS.has(el.nodeName.toUpperCase())) return true;
  if (el.hasAttribute("hidden")) return true;
  if ((el.getAttribute("aria-hidden") ?? "").trim().toLowerCase() === "true") return true;
  const style = el.getAttribute("style");
  return style !== null && HIDDEN_STYLE.test(style);
}

/** Absolute http(s) / mailto link target, or null for anything else (script, data, fragments). */
function safeHref(href: string | null, base: URL | undefined): string | null {
  if (href === null) return null;
  const h = href.trim();
  if (h === "" || h.startsWith("#")) return null;
  let url: URL;
  try {
    url = base === undefined ? new URL(h) : new URL(h, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") {
    return null;
  }
  return url.toString();
}

function createService(base: URL | undefined): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  // addRule unshifts, so this runs before the CommonMark rules (a hidden <p> is still dropped).
  service.addRule("psycheSafeLink", {
    filter: (node) => (node as unknown as ElementLike).nodeName === "A",
    replacement: (content, node) => {
      const href = safeHref((node as unknown as ElementLike).getAttribute("href"), base);
      const text = content.trim();
      if (href === null) return text;
      if (text === "") return "";
      return `[${text}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
    },
  });
  service.addRule("psycheSafeImage", {
    filter: (node) => (node as unknown as ElementLike).nodeName === "IMG",
    replacement: (_content, node) => {
      const el = node as unknown as ElementLike;
      const alt = (el.getAttribute("alt") ?? "").replace(/[[\]\n]/g, " ").trim();
      const src = safeHref(el.getAttribute("src"), base);
      if (src === null) return alt;
      return `![${alt}](${src.replace(/[()\s]/g, encodeURIComponent)})`;
    },
  });
  service.addRule("psycheDropHidden", {
    filter: (node) => isHiddenElement(node as unknown as ElementLike),
    replacement: () => "",
  });
  return service;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith("#x") || e.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(e.slice(2), 16) || 0xfffd);
    }
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10) || 0xfffd);
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** `<title>` text, whitespace-collapsed, max 300 chars. */
export function extractTitle(html: string): string | undefined {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (m === null) return undefined;
  const title = decodeEntities(m[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return title === "" ? undefined : title.slice(0, 300);
}

/** Convert `html`; relative links resolve against `baseUrl` (the page's final URL). */
export function htmlToMarkdown(html: string, baseUrl?: string | URL): string {
  let base: URL | undefined;
  try {
    base = baseUrl === undefined ? undefined : new URL(String(baseUrl));
  } catch {
    base = undefined;
  }
  // Turndown parses with domino; a full document's <head> lands in the body, so dropping
  // HEAD / TITLE / META above keeps it out of the output.
  return createService(base)
    .turndown(html)
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
