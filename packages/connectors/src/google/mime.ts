import { randomBytes } from "node:crypto";
import { PsycheError } from "@psyche/protocol";

/**
 * Gmail payload parsing and outgoing MIME. Gmail's `format=full` already splits the message into
 * a part tree, but the tree comes from whoever sent the mail: it can be deep, wide, mislabelled,
 * badly encoded or huge. Parsing is bounded (depth, part count, decoded text size) and never
 * throws on malformed input; it records what it skipped instead.
 */

export const MAX_PART_DEPTH = 16;
export const MAX_PARTS = 300;
export const MAX_TEXT_CHARS = 200_000;
/** Attachments larger than this are listed but never downloaded into the Library. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface AttachmentInfo {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
  /** Larger than `MAX_ATTACHMENT_BYTES`; listed only. */
  tooLarge: boolean;
}

export interface ParsedBody {
  text: string;
  /** `text/plain` part, else text derived from HTML, else empty. */
  source: "plain" | "html" | "none";
  attachments: AttachmentInfo[];
  /** Hardening notes: truncated, depth or part limit hit, undecodable parts. */
  warnings: string[];
}

/** Lenient base64url decode: ignores whitespace and missing padding; returns null when invalid. */
export function decodeBase64Url(data: string): Uint8Array | null {
  const clean = data.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  return new Uint8Array(Buffer.from(clean, "base64"));
}

export function encodeBase64Url(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString("base64url");
}

function header(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === lower)?.value;
}

function charsetOf(part: GmailPart): string {
  const ct = header(part.headers, "Content-Type") ?? "";
  const m = /charset\s*=\s*"?([A-Za-z0-9._-]+)"?/i.exec(ct);
  return (m?.[1] ?? "utf-8").toLowerCase();
}

function decodeText(bytes: Uint8Array, charset: string, warnings: string[]): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    warnings.push(`unknown charset ${charset}; decoded as UTF-8`);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/** Plain text from HTML for display to the model: drops hidden content, scripts and styles. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|template|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(
      /<([a-z0-9]+)\b[^>]*(?:\bhidden\b|aria-hidden\s*=\s*"?true|display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0(?:\.0+)?\b)[^>]*>[\s\S]*?<\/\1\s*>/gi,
      "",
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Walk a Gmail part tree within the limits; never throws on malformed input. */
export function parsePayload(payload: GmailPart | undefined): ParsedBody {
  const warnings: string[] = [];
  const attachments: AttachmentInfo[] = [];
  let plain: string | undefined;
  let html: string | undefined;
  let count = 0;
  const visit = (part: GmailPart | undefined, depth: number) => {
    if (part === undefined || part === null || typeof part !== "object") return;
    if (depth > MAX_PART_DEPTH) {
      if (!warnings.includes("part depth limit reached")) warnings.push("part depth limit reached");
      return;
    }
    count += 1;
    if (count > MAX_PARTS) {
      if (!warnings.includes("part count limit reached")) warnings.push("part count limit reached");
      return;
    }
    const mime = (typeof part.mimeType === "string" ? part.mimeType : "").toLowerCase();
    const disposition = (header(part.headers, "Content-Disposition") ?? "").toLowerCase();
    const filename = typeof part.filename === "string" ? part.filename : "";
    const isAttachment =
      filename !== "" ||
      disposition.startsWith("attachment") ||
      part.body?.attachmentId !== undefined;
    if (Array.isArray(part.parts) && mime.startsWith("multipart/")) {
      for (const child of part.parts) visit(child, depth + 1);
      return;
    }
    if (
      isAttachment &&
      !(mime.startsWith("text/") && filename === "" && part.body?.data !== undefined)
    ) {
      const size = Number.isFinite(part.body?.size) ? Math.max(0, Number(part.body?.size)) : 0;
      const info: AttachmentInfo = {
        partId: String(part.partId ?? count),
        filename: sanitizeFilename(filename || "attachment"),
        mimeType: mime || "application/octet-stream",
        size,
        tooLarge: size > MAX_ATTACHMENT_BYTES,
      };
      if (typeof part.body?.attachmentId === "string") info.attachmentId = part.body.attachmentId;
      attachments.push(info);
      return;
    }
    if (mime !== "text/plain" && mime !== "text/html") return;
    const data = part.body?.data;
    if (typeof data !== "string" || data === "") return;
    const bytes = decodeBase64Url(data);
    if (bytes === null) {
      warnings.push(`undecodable ${mime} part`);
      return;
    }
    const text = decodeText(bytes, charsetOf(part), warnings);
    if (mime === "text/plain" && plain === undefined) plain = text;
    if (mime === "text/html" && html === undefined) html = text;
  };
  visit(payload, 0);
  let text = plain ?? (html === undefined ? "" : htmlToText(html));
  const source = plain !== undefined ? "plain" : html !== undefined ? "html" : "none";
  if (text.length > MAX_TEXT_CHARS) {
    text = `${text.slice(0, MAX_TEXT_CHARS)}\n[truncated]`;
    warnings.push("body truncated");
  }
  return { text, source, attachments, warnings };
}

/** Strip path separators, control characters and leading dots from attachment names. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "attachment";
  const clean = base
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .slice(0, 200);
  return clean === "" ? "attachment" : clean;
}

// --- outgoing mail -------------------------------------------------------------------------------

export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface OutgoingMail {
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: OutgoingAttachment[];
}

/** Bare `local@domain` or `Name <local@domain>`; no CR/LF, no list separators inside. */
const ADDRESS =
  /^(?:[^<>\r\n,;"]{0,100}\s)?<?[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+>?$/;

export function assertAddress(value: string): void {
  if (!ADDRESS.test(value.trim())) {
    throw new PsycheError(
      "invalid_params",
      `invalid email address: ${JSON.stringify(value.slice(0, 80))}`,
    );
  }
}

function assertHeaderValue(value: string, name: string): void {
  if (/[\r\n]/.test(value))
    throw new PsycheError("invalid_params", `${name} contains a line break`);
}

/** RFC 2047 encoded-word for non-ASCII header text. */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Bare address in lower case, for binding hashes and grant keys. */
export function canonicalAddress(value: string): string {
  const m = /<([^>]+)>/.exec(value);
  return (m?.[1] ?? value).trim().toLowerCase();
}

/** RFC 5322 message, base64url-encoded for Gmail's `raw`. */
export function buildMime(mail: OutgoingMail, boundarySeed?: string): string {
  const all = [...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])];
  if (mail.to.length === 0)
    throw new PsycheError("invalid_params", "at least one recipient is required");
  if (all.length > 100) throw new PsycheError("invalid_params", "too many recipients");
  for (const a of all) assertAddress(a);
  if (mail.from !== undefined) assertAddress(mail.from);
  assertHeaderValue(mail.subject, "subject");
  if (mail.inReplyTo !== undefined) assertHeaderValue(mail.inReplyTo, "In-Reply-To");
  for (const r of mail.references ?? []) assertHeaderValue(r, "References");
  const boundary = `psyche-${boundarySeed ?? randomBytes(12).toString("hex")}`;
  const lines: string[] = [];
  if (mail.from !== undefined) lines.push(`From: ${mail.from}`);
  lines.push(`To: ${mail.to.join(", ")}`);
  if (mail.cc !== undefined && mail.cc.length > 0) lines.push(`Cc: ${mail.cc.join(", ")}`);
  if (mail.bcc !== undefined && mail.bcc.length > 0) lines.push(`Bcc: ${mail.bcc.join(", ")}`);
  lines.push(`Subject: ${encodeHeader(mail.subject)}`);
  if (mail.inReplyTo !== undefined) lines.push(`In-Reply-To: ${mail.inReplyTo}`);
  if (mail.references !== undefined && mail.references.length > 0) {
    lines.push(`References: ${mail.references.join(" ")}`);
  }
  lines.push("MIME-Version: 1.0");
  const textPart = [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(Buffer.from(mail.text, "utf8").toString("base64")),
  ];
  const htmlPart =
    mail.html === undefined
      ? undefined
      : [
          "Content-Type: text/html; charset=UTF-8",
          "Content-Transfer-Encoding: base64",
          "",
          wrap(Buffer.from(mail.html, "utf8").toString("base64")),
        ];
  const attachments = mail.attachments ?? [];
  if (htmlPart === undefined && attachments.length === 0) {
    lines.push(...textPart);
    return encodeBase64Url(lines.join("\r\n"));
  }
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "");
  const alt = `${boundary}-alt`;
  lines.push(`--${boundary}`);
  if (htmlPart === undefined) {
    lines.push(...textPart);
  } else {
    lines.push(`Content-Type: multipart/alternative; boundary="${alt}"`, "");
    lines.push(`--${alt}`, ...textPart, `--${alt}`, ...htmlPart, `--${alt}--`);
  }
  for (const a of attachments) {
    const name = sanitizeFilename(a.filename);
    assertHeaderValue(a.mimeType, "attachment type");
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.mimeType}; name="${encodeHeader(name).replace(/"/g, "")}"`,
      `Content-Disposition: attachment; filename="${encodeHeader(name).replace(/"/g, "")}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap(Buffer.from(a.bytes).toString("base64")),
    );
  }
  lines.push(`--${boundary}--`, "");
  return encodeBase64Url(lines.join("\r\n"));
}

function wrap(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}
