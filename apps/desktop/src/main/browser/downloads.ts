import { execFile as nodeExecFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

/**
 * Download quarantine (architecture §12, security §6): every agent-tab download is diverted by
 * `will-download` into `$PSYCHE_HOME/library/quarantine/<timestamp>-<sanitized filename>` and,
 * on macOS, tagged with `com.apple.quarantine` so Gatekeeper treats it as downloaded. Files are
 * never opened or executed from here without approval.
 */

/** Longest file name we produce, in UTF-8 bytes (APFS and ext4 allow 255). */
const MAX_NAME_BYTES = 200;

export function quarantineDir(home: string): string {
  return join(home, "library", "quarantine");
}

/** Creates the quarantine dir (0700) and returns it. */
export function ensureQuarantineDir(home: string): string {
  const dir = quarantineDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** C0/C1 controls, DEL, zero-width and bidi formatting characters. */
function isInvisible(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function truncateBytes(s: string, max: number): string {
  if (utf8Bytes(s) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (utf8Bytes(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/**
 * A single safe path segment: no separators, no control or bidi-override characters, no leading
 * dots (hidden files, `..`), no trailing dots or spaces, at most `maxBytes` UTF-8 bytes with the
 * extension kept. Empty results become `download`.
 */
export function sanitizeFilename(name: string, maxBytes = MAX_NAME_BYTES): string {
  let s = String(name).normalize("NFC");
  // Path separators (and `:`, which Finder shows as `/`) become `_`.
  s = s.replace(/[/\\:]/g, "_");
  // C0/C1 controls, DEL, and bidi/zero-width formatting characters (RTLO filename spoofing).
  s = [...s].filter((ch) => !isInvisible(ch.codePointAt(0) ?? 0)).join("");
  s = s.replace(/[<>"|?*]/g, "_");
  s = s.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
  if (s === "") s = "download";
  if (utf8Bytes(s) > maxBytes) {
    const ext = extname(s);
    const keepExt = ext.length > 1 && utf8Bytes(ext) <= 16 ? ext : "";
    const stem = truncateBytes(
      s.slice(0, s.length - keepExt.length),
      maxBytes - utf8Bytes(keepExt),
    );
    s = `${stem.replace(/[\s.]+$/, "") || "download"}${keepExt}`;
  }
  return s;
}

export interface QuarantinePathOptions {
  now?: () => number;
  exists?: (path: string) => boolean;
}

/**
 * `<quarantine>/<timestamp>-<sanitized>`; a counter is added when that name is taken. The result
 * always lies directly inside the quarantine dir.
 */
export function quarantinePath(
  home: string,
  filename: string,
  opts: QuarantinePathOptions = {},
): string {
  const dir = resolve(quarantineDir(home));
  const now = opts.now ?? Date.now;
  const exists = opts.exists ?? existsSync;
  const safe = sanitizeFilename(filename);
  const stamp = String(now());
  for (let n = 0; n < 10_000; n++) {
    const name = n === 0 ? `${stamp}-${safe}` : `${stamp}-${n}-${safe}`;
    const full = resolve(dir, name);
    if (dirname(full) !== dir || basename(full) !== name)
      throw new Error("quarantine path escaped its directory");
    if (!exists(full)) return full;
  }
  throw new Error("no free quarantine file name");
}

export type ExecFileFn = (file: string, args: string[], cb: (err: Error | null) => void) => void;

const defaultExecFile: ExecFileFn = (file, args, cb) => {
  nodeExecFile(file, args, { timeout: 5_000 }, (err) => cb(err));
};

/** `com.apple.quarantine` value: flags;hex seconds;agent;(no event uuid). */
export function quarantineAttributeValue(nowMs: number, agent = "Psyche"): string {
  return `0081;${Math.floor(nowMs / 1000).toString(16)};${agent};`;
}

/**
 * Best effort: tags `path` with the macOS quarantine attribute through `/usr/bin/xattr -w`
 * (execFile, no shell). Resolves false on other platforms or on failure; never throws.
 */
export function setQuarantineAttribute(
  path: string,
  opts: { platform?: NodeJS.Platform; execFile?: ExecFileFn; now?: () => number } = {},
): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return Promise.resolve(false);
  const run = opts.execFile ?? defaultExecFile;
  const value = quarantineAttributeValue((opts.now ?? Date.now)());
  return new Promise((done) => {
    try {
      run("/usr/bin/xattr", ["-w", "com.apple.quarantine", value, path], (err) => done(!err));
    } catch {
      done(false);
    }
  });
}
