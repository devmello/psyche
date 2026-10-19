/**
 * Magic-byte type sniffing for quarantined downloads (feature I9). The declared MIME type and
 * file name come from the server and are untrusted; the sniffed type is what the Library and
 * the viewers rely on, and executables are flagged so nothing ever opens them automatically.
 */

export interface SniffResult {
  mime: string;
  /** Machine code, scripts or installers: never opened, only revealed in Finder. */
  executable: boolean;
  /** The declared MIME type or extension disagrees with the bytes. */
  mismatch: boolean;
}

interface Sig {
  mime: string;
  bytes: (number | null)[];
  offset?: number;
  executable?: boolean;
}

const SIGS: Sig[] = [
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  {
    mime: "image/webp",
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
  },
  { mime: "application/zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: "application/gzip", bytes: [0x1f, 0x8b] },
  { mime: "application/x-7z-compressed", bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { mime: "application/x-rar-compressed", bytes: [0x52, 0x61, 0x72, 0x21] },
  { mime: "application/x-apple-diskimage", bytes: [0x6b, 0x6f, 0x6c, 0x79], executable: true },
  { mime: "application/x-xar", bytes: [0x78, 0x61, 0x72, 0x21], executable: true },
  { mime: "application/x-elf", bytes: [0x7f, 0x45, 0x4c, 0x46], executable: true },
  { mime: "application/x-msdownload", bytes: [0x4d, 0x5a], executable: true },
  { mime: "application/x-mach-binary", bytes: [0xcf, 0xfa, 0xed, 0xfe], executable: true },
  { mime: "application/x-mach-binary", bytes: [0xce, 0xfa, 0xed, 0xfe], executable: true },
  { mime: "application/x-mach-binary", bytes: [0xca, 0xfe, 0xba, 0xbe], executable: true },
  { mime: "text/x-shellscript", bytes: [0x23, 0x21], executable: true },
];

const EXECUTABLE_EXT =
  /\.(app|command|sh|bash|zsh|py|rb|pl|js|mjs|jar|exe|msi|bat|cmd|ps1|scpt|pkg|dmg|bin|run|elf|dylib|so|workflow|terminal|webloc|inetloc)$/i;

const OOXML: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function matches(buf: Uint8Array, sig: Sig): boolean {
  const off = sig.offset ?? 0;
  if (buf.length < off + sig.bytes.length) return false;
  return sig.bytes.every((b, i) => b === null || buf[off + i] === b);
}

function looksLikeText(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) {
    const c = buf[i] ?? 0;
    if (c === 0) return false;
    if (c < 0x09 || (c > 0x0d && c < 0x20 && c !== 0x1b)) return false;
  }
  return true;
}

export function sniff(head: Uint8Array, filename: string, declared: string | null): SniffResult {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  let mime = "application/octet-stream";
  let executable = EXECUTABLE_EXT.test(filename);
  const sig = SIGS.find((s) => matches(head, s));
  if (sig !== undefined) {
    mime = sig.mime;
    if (sig.executable === true) executable = true;
    if (mime === "application/zip" && OOXML[ext] !== undefined) mime = OOXML[ext];
  } else if (looksLikeText(head)) {
    const start = new TextDecoder().decode(head.slice(0, 512)).trimStart().toLowerCase();
    if (start.startsWith("<!doctype html") || start.startsWith("<html")) mime = "text/html";
    else if (start.startsWith("<?xml") || start.startsWith("<svg"))
      mime = start.includes("<svg") ? "image/svg+xml" : "application/xml";
    else if (start.startsWith("{") || start.startsWith("[")) mime = "application/json";
    else if (ext === "csv") mime = "text/csv";
    else mime = "text/plain";
  }
  const declaredBase = (declared ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const textual = (m: string) =>
    m.startsWith("text/") || m === "application/json" || m === "application/xml";
  const mismatch =
    declaredBase !== "" &&
    declaredBase !== "application/octet-stream" &&
    declaredBase !== mime &&
    !(textual(declaredBase) && textual(mime));
  return { mime, executable, mismatch };
}
