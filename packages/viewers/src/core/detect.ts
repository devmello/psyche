import { extensionOf, normalizeMime } from "./registry.ts";

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
  xls: "application/vnd.ms-excel",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  odp: "application/vnd.oasis.opendocument.presentation",
  key: "application/vnd.apple.keynote",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  json: "application/json",
  jsonl: "application/json",
  geojson: "application/json",
  md: "text/markdown",
  markdown: "text/markdown",
  mdx: "text/markdown",
  eml: "message/rfc822",
  txt: "text/plain",
  log: "text/plain",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  py: "text/x-python",
  css: "text/css",
  sh: "application/x-sh",
};

/** Best-effort MIME for a file name (extension table). */
export function mimeFromName(name: string): string | undefined {
  const ext = extensionOf(name);
  return ext === undefined ? undefined : EXT_MIME[ext];
}

const startsWith = (bytes: Uint8Array, sig: readonly number[], at = 0) =>
  sig.every((b, i) => bytes[at + i] === b);

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, Math.min(to, bytes.length)));

/**
 * Sniffs the leading bytes. Returns undefined when the bytes say nothing definite (plain text,
 * or a ZIP whose kind cannot be told without opening it).
 */
export function sniffMime(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (brand === "avif") return "image/avif";
    if (brand === "heic" || brand === "heix") return "image/heic";
    if (brand.startsWith("M4A")) return "audio/mp4";
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return "application/x-ole-storage";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // OOXML packages list their main part early; look in the first local headers.
    const head = ascii(bytes, 0, 4096);
    if (head.includes("word/")) return EXT_MIME.docx;
    if (head.includes("xl/")) return EXT_MIME.xlsx;
    if (head.includes("ppt/")) return EXT_MIME.pptx;
    return "application/zip";
  }
  return undefined;
}

export interface DetectInput {
  name: string;
  mime?: string;
  bytes?: Uint8Array;
}

const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream", "application/zip"]);

/**
 * Picks the MIME type the registry should resolve: a specific declared type wins, then sniffed
 * bytes, then the extension. A declared type that disagrees with the bytes (a `.pdf` that is
 * really HTML) falls back to `application/octet-stream` so it never reaches a rich viewer.
 */
export function detectMime(input: DetectInput): string {
  const declared = normalizeMime(input.mime ?? "");
  const sniffed = input.bytes === undefined ? undefined : sniffMime(input.bytes);
  const byName = mimeFromName(input.name);
  if (
    sniffed !== undefined &&
    sniffed !== "application/zip" &&
    sniffed !== "application/x-ole-storage"
  ) {
    return sniffed;
  }
  const claimed = !GENERIC.has(declared) ? declared : (byName ?? declared);
  // Bytes were given but did not sniff as PDF (that would have returned above).
  if (input.bytes !== undefined && claimed === "application/pdf") {
    return "application/octet-stream";
  }
  if (claimed.length > 0) return claimed;
  return sniffed ?? "application/octet-stream";
}
