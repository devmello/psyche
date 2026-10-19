/**
 * Markdown → channel flavor (feature N1 "outbound formatting"). The agent writes CommonMark-ish
 * Markdown; each channel gets either plain text or Telegram's HTML subset. Only `http(s)` links
 * survive as links; everything else is escaped text. Approval cards never go through here: they
 * are always plain text (review design-12).
 */

export type Flavor = "plain" | "telegram-html";

interface Block {
  kind: "code" | "text";
  lang?: string;
  body: string;
}

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;

/** Splits Markdown into fenced code blocks and text runs (an unclosed fence runs to the end). */
export function splitBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length > 0) blocks.push({ kind: "text", body: text.join("\n") });
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i] ?? "");
    if (open === null) {
      text.push(lines[i] ?? "");
      continue;
    }
    flush();
    const marker = open[2] ?? "```";
    const lang = open[3] ?? "";
    const body: string[] = [];
    i++;
    while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) {
      body.push(lines[i] ?? "");
      i++;
    }
    blocks.push({ kind: "code", ...(lang === "" ? {} : { lang }), body: body.join("\n") });
  }
  flush();
  return blocks;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function safeHref(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

type Inline = (text: string) => string;

/**
 * Inline spans: `code`, **bold**, __bold__, *italic*, _italic_, ~~strike~~, [text](url).
 * Code spans are cut out first so their content is never formatted.
 */
function inline(text: string, flavor: Flavor): string {
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        const code = part.slice(1, -1);
        return flavor === "plain" ? code : `<code>${escapeHtml(code)}</code>`;
      }
      return flavor === "plain" ? inlinePlain(part) : inlineHtml(part);
    })
    .join("");
}

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const BOLD = /(\*\*|__)(?=\S)([^\n]*?\S)\1/g;
const ITALIC = /(^|[^\w*])([*_])(?=\S)([^\n*_]*?\S)\2(?![\w*])/g;
const STRIKE = /~~(?=\S)([^\n]*?\S)~~/g;

const inlinePlain: Inline = (text) =>
  text
    .replace(LINK, (_m, label: string, url: string) => {
      const href = safeHref(url);
      return href === undefined || label === url ? label : `${label} (${href})`;
    })
    .replace(BOLD, "$2")
    .replace(STRIKE, "$1")
    .replace(ITALIC, "$1$3");

const inlineHtml: Inline = (text) => {
  // Links are replaced by private-use placeholders so the escaping and emphasis passes cannot touch them.
  const links: string[] = [];
  const withMarks = text.replace(/\uE000/g, "").replace(LINK, (_m, label: string, url: string) => {
    const href = safeHref(url);
    const html =
      href === undefined
        ? escapeHtml(label)
        : `<a href="${escapeAttr(href)}">${escapeHtml(label)}</a>`;
    links.push(html);
    return `\uE000${links.length - 1}\uE000`;
  });
  const html = escapeHtml(withMarks)
    .replace(BOLD, "<b>$2</b>")
    .replace(STRIKE, "<s>$1</s>")
    .replace(ITALIC, "$1<i>$3</i>");
  // Overlapping emphasis (`**a _b** c_`) would produce mis-nested tags that Telegram rejects;
  // fall back to the escaped plain rendering of this span instead.
  const safe = wellNested(html) ? html : escapeHtml(inlinePlain(text.replace(/\uE000/g, "")));
  return safe.replace(/\uE000(\d+)\uE000/g, (_m, n: string) => links[Number(n)] ?? "");
};

/** True when every `<b>`, `<i>`, `<s>` tag closes in stack order. */
export function wellNested(html: string): boolean {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([bis])>/g)) {
    if (m[1] === "") stack.push(m[2] ?? "");
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}

function textBlock(body: string, flavor: Flavor): string {
  return body
    .split("\n")
    .map((line) => {
      const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading !== null) {
        const content = inline(heading[1] ?? "", flavor);
        return flavor === "plain" ? content : `<b>${content}</b>`;
      }
      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      if (bullet !== null) return `${bullet[1] ?? ""}• ${inline(bullet[2] ?? "", flavor)}`;
      const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
      if (quote !== null) {
        const content = inline(quote[1] ?? "", flavor);
        return flavor === "plain" ? `> ${content}` : `<blockquote>${content}</blockquote>`;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return "———";
      return inline(line, flavor);
    })
    .join("\n")
    .replace(/<\/blockquote>\n<blockquote>/g, "\n");
}

function codeBlock(block: Block, flavor: Flavor): string {
  if (flavor === "plain") return block.body;
  const cls = block.lang === undefined ? "" : ` class="language-${escapeAttr(block.lang)}"`;
  return `<pre><code${cls}>${escapeHtml(block.body)}</code></pre>`;
}

/** Renders Markdown in a channel flavor. */
export function renderMarkdown(markdown: string, flavor: Flavor): string {
  return splitBlocks(markdown)
    .map((b) => (b.kind === "code" ? codeBlock(b, flavor) : textBlock(b.body, flavor)))
    .join("\n");
}

/** Plain text passed through unchanged except for HTML escaping in the HTML flavor. */
export function renderPlain(text: string, flavor: Flavor): string {
  return flavor === "plain" ? text : escapeHtml(text);
}
