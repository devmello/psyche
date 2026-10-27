import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join, posix } from "node:path";

/**
 * The web client from the desktop app's `app.asar` (docs/design/lightweight-2026.md, S2). In
 * Psyche.app the desktop renderer build also holds the web client (`web.html` and the chunks it
 * shares with the desktop window), so the Gateway serves that copy instead of shipping a second
 * 32 MB one. Nothing is trusted that Electron would not trust: the archive header must match the
 * `ElectronAsarIntegrity` hash in the app's Info.plist (what the EnableEmbeddedAsarIntegrityValidation
 * fuse checks), and every file is checked against its own SHA-256 from that header before it is
 * served.
 */

/** Where the renderer build sits inside app.asar, and the page served as the web client. */
export const ASAR_WEB_DIR = ".vite/renderer/main_window";
export const ASAR_WEB_INDEX = "web.html";

interface AsarEntry {
  files?: Record<string, AsarEntry>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
  link?: string;
  integrity?: { algorithm: string; hash: string };
}

/** `Contents/Resources/app.asar` for a Gateway bundle at `Contents/Resources/psyched/app`. */
export function packagedAsar(assetsRoot: string): string | null {
  const asar = join(assetsRoot, "..", "..", "app.asar");
  return existsSync(asar) ? asar : null;
}

/** The `ElectronAsarIntegrity` hash of `Resources/app.asar` in an Info.plist (XML), if any. */
export function asarHashFromInfoPlist(xml: string): string | undefined {
  const m =
    /<key>ElectronAsarIntegrity<\/key>\s*<dict>\s*<key>Resources\/app\.asar<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(
      xml,
    );
  const body = m?.[1];
  if (body === undefined) return undefined;
  if (!/<key>algorithm<\/key>\s*<string>SHA256<\/string>/.test(body)) return undefined;
  return /<key>hash<\/key>\s*<string>([0-9a-f]{64})<\/string>/.exec(body)?.[1];
}

export class AsarWebRoot {
  readonly #path: string;
  readonly #dataOffset: number;
  readonly #root: AsarEntry;

  private constructor(path: string, dataOffset: number, root: AsarEntry) {
    this.#path = path;
    this.#dataOffset = dataOffset;
    this.#root = root;
  }

  /**
   * Opens `asar` and checks its header against `expectedHash` (from the app's Info.plist; the
   * default reads it from `<app>/Contents/Info.plist`). Throws when the hash is missing or wrong.
   */
  static open(asar: string, expectedHash?: string): AsarWebRoot {
    const want =
      expectedHash ??
      asarHashFromInfoPlist(readFileSync(join(dirname(dirname(asar)), "Info.plist"), "utf8"));
    if (want === undefined) throw new Error("app.asar has no integrity hash in Info.plist");
    const fd = openSync(asar, "r");
    try {
      const size = Buffer.alloc(8);
      readSync(fd, size, 0, 8, 0);
      const headerSize = size.readUInt32LE(4);
      const header = Buffer.alloc(headerSize);
      readSync(fd, header, 0, headerSize, 8);
      const json = header.toString("utf8", 8, 8 + header.readUInt32LE(4));
      const got = createHash("sha256").update(json).digest("hex");
      if (got !== want) throw new Error("app.asar header does not match its integrity hash");
      return new AsarWebRoot(asar, 8 + headerSize, JSON.parse(json) as AsarEntry);
    } finally {
      closeSync(fd);
    }
  }

  /** A regular, packed file at `rel` below `ASAR_WEB_DIR` (no links, no unpacked files), or null. */
  #entry(rel: string): AsarEntry | null {
    // Normalised against "/" first, so ".." can never climb out of the web folder.
    const parts = `${ASAR_WEB_DIR}${posix.normalize(`/${rel}`)}`.split("/");
    let node: AsarEntry | undefined = this.#root;
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      node = node?.files?.[part];
      if (node === undefined) return null;
    }
    if (node === undefined || node.files !== undefined || node.link !== undefined) return null;
    if (node.unpacked === true || node.offset === undefined || node.size === undefined) return null;
    return node;
  }

  has(rel: string): boolean {
    return this.#entry(rel) !== null;
  }

  /** The file's bytes after its SHA-256 matched the header's; null when absent or tampered. */
  read(rel: string): Buffer | null {
    const e = this.#entry(rel);
    if (e?.integrity === undefined || e.integrity.algorithm !== "SHA256") return null;
    const buf = Buffer.alloc(e.size ?? 0);
    const fd = openSync(this.#path, "r");
    try {
      readSync(fd, buf, 0, buf.length, this.#dataOffset + Number(e.offset));
    } finally {
      closeSync(fd);
    }
    return createHash("sha256").update(buf).digest("hex") === e.integrity.hash ? buf : null;
  }
}
