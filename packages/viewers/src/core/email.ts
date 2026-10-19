import DOMPurify from "dompurify";

/**
 * Email preview (P4, docs/06 §3.7). Messages are untrusted: HTML is sanitized with DOMPurify,
 * remote images are blocked until the user clicks "Load remote images" (tracking pixels), `cid:`
 * images resolve to inline attachments, and the result renders in the artifact sandbox with
 * scripts off. The parser (postal-mime) never touches the network.
 */

export interface EmailAddress {
  name: string;
  address: string;
}

export interface EmailAttachment {
  filename: string;
  mime: string;
  size: number;
  contentId?: string;
  inline: boolean;
  content: Uint8Array;
}

export interface ParsedEmail {
  subject: string;
  from?: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  date?: string;
  messageId?: string;
  html?: string;
  text?: string;
  attachments: EmailAttachment[];
}

type PostalAddress = { name: string; address?: string; group?: { name: string; address: string }[] };

const flatten = (list: PostalAddress[] | undefined): EmailAddress[] =>
  (list ?? []).flatMap((a) =>
    a.group !== undefined ? a.group : a.address === undefined ? [] : [{ name: a.name, address: a.address }],
  );

const toBytes = (c: ArrayBuffer | Uint8Array | string): Uint8Array =>
  typeof c === "string" ? new TextEncoder().encode(c) : c instanceof Uint8Array ? c : new Uint8Array(c);

export async function parseEmail(raw: Uint8Array | string): Promise<ParsedEmail> {
  const { default: PostalMime } = await import("postal-mime");
  const email = await PostalMime.parse(typeof raw === "string" ? raw : raw.slice(), {
    attachmentEncoding: "arraybuffer",
  });
  const from = email.from === undefined ? [] : flatten([email.from as PostalAddress]);
  const parsed: ParsedEmail = {
    subject: email.subject ?? "",
    to: flatten(email.to as PostalAddress[] | undefined),
    cc: flatten(email.cc as PostalAddress[] | undefined),
    attachments: email.attachments.map((a) => {
      const content = toBytes(a.content);
      const att: EmailAttachment = {
        filename: a.filename ?? "attachment",
        mime: a.mimeType,
        size: content.byteLength,
        inline: a.disposition === "inline" || a.related === true,
        content,
      };
      if (a.contentId !== undefined) att.contentId = a.contentId.replace(/^<|>$/g, "");
      return att;
    }),
  };
  if (from[0] !== undefined) parsed.from = from[0];
  if (email.date !== undefined) parsed.date = email.date;
  if (email.messageId !== undefined) parsed.messageId = email.messageId;
  if (email.html !== undefined) parsed.html = email.html;
  if (email.text !== undefined) parsed.text = email.text;
  return parsed;
}

export interface SanitizeEmailOptions {
  /** Default false: remote images become placeholders until the user opts in. */
  allowRemoteImages?: boolean;
  /** `cid:` → URL (normally a `data:` or `blob:` URL of the inline attachment). */
  resolveCid?: (contentId: string) => string | undefined;
  /** The DOM to sanitize with; defaults to the global window (renderer). Node passes jsdom's. */
  window?: Window;
}

export interface SanitizedEmail {
  html: string;
  blockedImages: number;
}

const FORBID_TAGS = [
  "script", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button",
  "textarea", "select", "option", "meta", "link", "base", "portal", "template", "noscript", "svg",
  "math",
];
const FORBID_ATTR = ["srcset", "ping", "formaction", "action", "background", "poster", "xlink:href"];

const REMOTE_URL_IN_CSS = /url\(\s*(['"]?)\s*(?!data:|cid:)[^)]*\1\s*\)/gi;
const BLOCKED_PIXEL =
  "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E";

/** Sanitizes message HTML for display in the sandbox. Pure function of its inputs. */
export function sanitizeEmailHtml(html: string, opts: SanitizeEmailOptions = {}): SanitizedEmail {
  const win = opts.window ?? (globalThis as { window?: Window }).window;
  if (win === undefined) throw new Error("sanitizeEmailHtml needs a DOM window");
  const purify = DOMPurify(win as unknown as Parameters<typeof DOMPurify>[0]);
  let blocked = 0;
  purify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    if (el.tagName === "IMG") {
      const src = (el.getAttribute("src") ?? "").trim();
      if (/^cid:/i.test(src)) {
        const url = opts.resolveCid?.(decodeURIComponent(src.slice(4)));
        if (url === undefined) el.removeAttribute("src");
        else el.setAttribute("src", url);
      } else if (/^https?:/i.test(src) && !opts.allowRemoteImages) {
        el.setAttribute("data-psyche-blocked-src", src.slice(0, 2048));
        el.setAttribute("src", BLOCKED_PIXEL);
        el.setAttribute("alt", el.getAttribute("alt") ?? "");
        blocked++;
      } else if (!/^(https?:|data:image\/|blob:)/i.test(src)) {
        el.removeAttribute("src");
      }
    }
    if (el.tagName === "A") {
      el.setAttribute("rel", "noopener noreferrer");
      el.setAttribute("target", "_blank");
    }
    const style = el.getAttribute("style");
    if (style !== null && !opts.allowRemoteImages && REMOTE_URL_IN_CSS.test(style)) {
      REMOTE_URL_IN_CSS.lastIndex = 0;
      el.setAttribute("style", style.replace(REMOTE_URL_IN_CSS, "none"));
      blocked++;
    }
    REMOTE_URL_IN_CSS.lastIndex = 0;
  });
  purify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style" && !opts.allowRemoteImages) {
      const el = node as Element;
      const css = el.textContent ?? "";
      const cleaned = css.replace(/@import[^;]*;?/gi, "").replace(REMOTE_URL_IN_CSS, "none");
      if (cleaned !== css) {
        blocked++;
        el.textContent = cleaned;
      }
    }
  });
  const out = purify.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ["target"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|cid:|data:image\/(?:png|gif|jpe?g|webp);|blob:|#)/i,
    WHOLE_DOCUMENT: false,
    RETURN_TRUSTED_TYPE: false,
  }) as string;
  purify.removeAllHooks();
  return { html: out, blockedImages: blocked };
}

/** Plain-text rendering of an email for the agent (headers + text body or stripped HTML). */
export function emailToText(email: ParsedEmail, htmlToText: (html: string) => string): string {
  const fmt = (a: EmailAddress) => (a.name ? `${a.name} <${a.address}>` : a.address);
  const lines = [
    `Subject: ${email.subject}`,
    ...(email.from ? [`From: ${fmt(email.from)}`] : []),
    ...(email.to.length ? [`To: ${email.to.map(fmt).join(", ")}`] : []),
    ...(email.cc.length ? [`Cc: ${email.cc.map(fmt).join(", ")}`] : []),
    ...(email.date ? [`Date: ${email.date}`] : []),
    ...(email.attachments.length
      ? [`Attachments: ${email.attachments.filter((a) => !a.inline).map((a) => `${a.filename} (${a.mime}, ${a.size} bytes)`).join("; ")}`]
      : []),
    "",
    email.text ?? (email.html === undefined ? "" : htmlToText(email.html)),
  ];
  return lines.join("\n").trim();
}

/** Tag-stripping HTML → text without a DOM (good enough for extraction; never rendered). */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style|head|template)[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
