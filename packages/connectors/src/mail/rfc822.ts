import {
  encodeBase64Url,
  type GmailHeader,
  type GmailPart,
  MAX_PART_DEPTH,
  MAX_PARTS,
  parsePayload,
  sanitizeFilename,
} from "../google/mime.ts";
import type { MailMessageView } from "./types.ts";

/**
 * RFC 5322 / MIME parsing for raw messages (IMAP `BODY[]`, JMAP blobs). The message is turned
 * into the same part tree Gmail's `format=full` returns, so `parsePayload` applies the same
 * bounds (depth 16, 300 parts, 200k characters of text) and the same hidden-text stripping.
 * Parsing never throws on malformed input: a broken part is skipped and recorded as a warning.
 */

/** Raw messages above this size are parsed for headers only (the body is reported truncated). */
export const MAX_RAW_BYTES = 50 * 1024 * 1024;

export interface RawHeader {
  name: string;
  value: string;
}

const CRLF = "\r\n";

/** Header block → unfolded headers (names kept as written, values with folding whitespace joined). */
export function parseHeaders(block: string): RawHeader[] {
  const out: RawHeader[] = [];
  const lines = block.split(/\r?\n/);
  let current: RawHeader | undefined;
  for (const line of lines) {
    if (line === "") continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && current !== undefined) {
      current.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) continue;
    current = { name, value: line.slice(colon + 1).trim() };
    out.push(current);
  }
  return out;
}

export function headerValue(headers: RawHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function decodeQ(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "_") bytes.push(0x20);
    else if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(c.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(bytes);
}

/** RFC 2047 encoded-words (`=?charset?B|Q?text?=`), adjacent words joined without the space. */
export function decodeHeaderValue(value: string): string {
  const re = /=\?([A-Za-z0-9._-]+)(?:\*[A-Za-z-]+)?\?([BbQq])\?([^?\s]*)\?=/g;
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?)/g, "$1")
    .replace(re, (_m, charset: string, enc: string, text: string) => {
      const bytes =
        enc.toUpperCase() === "B"
          ? new Uint8Array(Buffer.from(text.replace(/[^A-Za-z0-9+/=]/g, ""), "base64"))
          : decodeQ(text);
      return decodeCharset(bytes, charset);
    });
}

export interface ContentType {
  type: string;
  params: Record<string, string>;
}

/**
 * `type/subtype; a=b; c="d"` with RFC 2231 continuations (`name*0*=utf-8''...`) folded into one
 * decoded parameter. Unknown or malformed input yields `text/plain`.
 */
export function parseContentType(value: string | undefined): ContentType {
  if (value === undefined) return { type: "text/plain", params: {} };
  const parts = splitParams(value);
  const type = (parts.shift() ?? "").trim().toLowerCase();
  const params: Record<string, string> = {};
  const continued = new Map<string, { encoded: boolean; segments: Map<number, string> }>();
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    let name = p.slice(0, eq).trim().toLowerCase();
    let raw = p.slice(eq + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      raw = raw.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(name);
    if (m === null) continue;
    name = m[1] as string;
    const index = m[2] === undefined ? undefined : Number(m[2]);
    const encoded = m[3] !== undefined;
    if (index === undefined && !encoded) {
      params[name] = decodeHeaderValue(raw);
      continue;
    }
    const entry = continued.get(name) ?? { encoded: false, segments: new Map() };
    if (encoded) entry.encoded = true;
    entry.segments.set(index ?? 0, raw);
    continued.set(name, entry);
  }
  for (const [name, entry] of continued) {
    const joined = [...entry.segments.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, s]) => s)
      .join("");
    params[name] = entry.encoded ? decodeRfc2231(joined) : joined;
  }
  return { type: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : "text/plain", params };
}

function decodeRfc2231(value: string): string {
  const m = /^([^']*)'[^']*'(.*)$/s.exec(value);
  const charset = m === null ? "utf-8" : m[1] || "utf-8";
  const text = m === null ? value : (m[2] as string);
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(text.charCodeAt(i) & 0xff);
  }
  return decodeCharset(new Uint8Array(bytes), charset);
}

/** Split on `;` outside quotes. */
function splitParams(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (c === '"') quoted = !quoted;
    if (c === "\\" && quoted && i + 1 < value.length) {
      cur += c + value[i + 1];
      i += 1;
      continue;
    }
    if (c === ";" && !quoted) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

export function decodeQuotedPrintable(text: string): Uint8Array {
  const bytes: number[] = [];
  const s = text.replace(/=\r?\n/g, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(c.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(bytes);
}

/** Apply `Content-Transfer-Encoding`; unknown encodings pass the bytes through. */
export function decodeTransfer(body: string, encoding: string | undefined): Uint8Array {
  const enc = (encoding ?? "7bit").trim().toLowerCase();
  if (enc === "base64") {
    return new Uint8Array(Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64"));
  }
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  return Buffer.from(body, "latin1");
}

/**
 * Parse a raw message into Gmail's part shape. Bodies are transfer-decoded and base64url-encoded
 * like Gmail's `body.data`; attachments get `attachmentId` = their part id so the session can
 * fetch them later. Works on a latin1 view of the bytes so offsets stay byte-exact.
 */
export function parseRawMessage(raw: Uint8Array): { headers: RawHeader[]; payload: GmailPart } {
  const text = Buffer.from(raw.subarray(0, MAX_RAW_BYTES)).toString("latin1");
  let count = 0;
  const build = (block: string, partId: string, depth: number): GmailPart => {
    count += 1;
    const split = splitHeadersAndBody(block);
    const headers = parseHeaders(split.headers);
    const ct = parseContentType(headerValue(headers, "Content-Type"));
    const disposition = parseContentType(headerValue(headers, "Content-Disposition"));
    const filename = disposition.params.filename ?? ct.params.name ?? "";
    const part: GmailPart = {
      partId,
      mimeType: ct.type,
      filename: filename === "" ? "" : sanitizeFilename(decodeHeaderValue(filename)),
      headers: headers.map((h): GmailHeader => ({ name: h.name, value: h.value })),
    };
    const boundary = ct.params.boundary;
    if (
      ct.type.startsWith("multipart/") &&
      boundary !== undefined &&
      boundary !== "" &&
      // One level past the limits, so `parsePayload` sees and reports the overflow.
      depth <= MAX_PART_DEPTH &&
      count <= MAX_PARTS
    ) {
      part.parts = splitMultipart(split.body, boundary).map((child, i) =>
        build(child, partId === "" ? String(i + 1) : `${partId}.${i + 1}`, depth + 1),
      );
      part.body = { size: 0 };
      return part;
    }
    if (ct.type === "message/rfc822") {
      // Treat the embedded message as an attachment of its own; its text is not inlined.
      part.mimeType = "message/rfc822";
      part.filename = part.filename === "" ? "message.eml" : part.filename;
    }
    const bytes = decodeTransfer(split.body, headerValue(headers, "Content-Transfer-Encoding"));
    const isAttachment =
      part.filename !== "" || disposition.type === "attachment" || !ct.type.startsWith("text/");
    part.body = isAttachment
      ? { size: bytes.byteLength, attachmentId: partId === "" ? "1" : partId }
      : { size: bytes.byteLength, data: encodeBase64Url(bytes) };
    return part;
  };
  const payload = build(text, "", 0);
  if (payload.partId === "") payload.partId = "1";
  if (raw.byteLength > MAX_RAW_BYTES) {
    payload.headers = [
      ...(payload.headers ?? []),
      { name: "X-Psyche-Warning", value: "message truncated at 50 MB" },
    ];
  }
  return { headers: parseHeaders(splitHeadersAndBody(text).headers), payload };
}

function splitHeadersAndBody(block: string): { headers: string; body: string } {
  const m = /\r?\n\r?\n/.exec(block);
  if (m === null) {
    // No blank line: a header-only block, or a bare body without headers.
    return /^[\x21-\x39\x3b-\x7e]+:/.test(block)
      ? { headers: block, body: "" }
      : { headers: "", body: block };
  }
  return { headers: block.slice(0, m.index), body: block.slice(m.index + m[0].length) };
}

/** Body parts between `--boundary` lines; the preamble and epilogue are dropped. */
export function splitMultipart(body: string, boundary: string): string[] {
  const parts: string[] = [];
  const lines = body.split(/\r?\n/);
  let current: string[] | undefined;
  for (const line of lines) {
    if (line === `--${boundary}` || line === `--${boundary}--`) {
      if (current !== undefined) parts.push(current.join(CRLF));
      current = line.endsWith("--") ? undefined : [];
      if (current === undefined) break;
      continue;
    }
    current?.push(line);
  }
  if (current !== undefined) parts.push(current.join(CRLF));
  return parts;
}

/** Find a part by id in a parsed tree. */
export function findPart(part: GmailPart, partId: string): GmailPart | undefined {
  if (part.partId === partId) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, partId);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The decoded bytes of one attachment part of a raw message. */
export function attachmentBytes(
  raw: Uint8Array,
  partId: string,
): { filename: string; mimeType: string; bytes: Uint8Array } | undefined {
  const text = Buffer.from(raw.subarray(0, MAX_RAW_BYTES)).toString("latin1");
  const path = partId.split(".").map((n) => Number(n));
  let block = text;
  for (let i = 0; i < path.length; i++) {
    const split = splitHeadersAndBody(block);
    const ct = parseContentType(headerValue(parseHeaders(split.headers), "Content-Type"));
    const boundary = ct.params.boundary;
    if (!ct.type.startsWith("multipart/") || boundary === undefined) {
      if (i === 0 && path.length === 1 && path[0] === 1) break;
      return undefined;
    }
    const child = splitMultipart(split.body, boundary)[(path[i] as number) - 1];
    if (child === undefined) return undefined;
    block = child;
  }
  const split = splitHeadersAndBody(block);
  const headers = parseHeaders(split.headers);
  const ct = parseContentType(headerValue(headers, "Content-Type"));
  const disposition = parseContentType(headerValue(headers, "Content-Disposition"));
  const filename = decodeHeaderValue(disposition.params.filename ?? ct.params.name ?? "attachment");
  return {
    filename: sanitizeFilename(filename),
    mimeType: ct.type,
    bytes: decodeTransfer(split.body, headerValue(headers, "Content-Transfer-Encoding")),
  };
}

/** A message view from raw bytes plus the backend's envelope metadata. */
export function messageViewFromRaw(
  raw: Uint8Array,
  meta: {
    id: string;
    mailbox: string;
    threadId?: string;
    date?: string;
    unread: boolean;
    flags: string[];
    size?: number;
  },
): MailMessageView {
  const { headers, payload } = parseRawMessage(raw);
  const h = (name: string) => decodeHeaderValue(headerValue(headers, name) ?? "").slice(0, 2000);
  const parsed = parsePayload(payload);
  const view: MailMessageView = {
    id: meta.id,
    mailbox: meta.mailbox,
    subject: h("Subject"),
    from: h("From"),
    to: h("To"),
    cc: h("Cc"),
    date: meta.date ?? h("Date"),
    snippet: parsed.text.replace(/\s+/g, " ").trim().slice(0, 200),
    unread: meta.unread,
    flags: meta.flags,
    messageId: h("Message-ID"),
    inReplyTo: h("In-Reply-To"),
    references: h("References"),
    body: parsed.text,
    bodySource: parsed.source,
    attachments: parsed.attachments,
    warnings: parsed.warnings,
  };
  if (meta.threadId !== undefined) view.threadId = meta.threadId;
  if (meta.size !== undefined) view.size = meta.size;
  return view;
}
