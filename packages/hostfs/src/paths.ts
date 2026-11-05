import { posix, win32 } from "node:path";

/**
 * Host paths as the permission broker and the file executors compare them (no file system access).
 *
 * Two forms exist. A POSIX path (`/Users/o/Docs`, and the sandbox's `/workspace` on every host) is
 * compared byte for byte, as before. On Windows a host path is a drive path (`C:\Users\o\Docs`) or a
 * UNC share (`\\server\share\dir`): separators become `\`, the drive letter is upper-cased, `\\?\`
 * long-path prefixes are dropped, and comparison ignores case, as NTFS does (`c:\users\o\docs` is
 * the same folder). The forms never match each other.
 *
 * Win32 rewrites some names before NTFS sees them, so lexical checks could be fooled by a name that
 * looks different but opens the same file. Those names are refused instead of guessed at:
 * alternate data streams (`a.txt:secret`, `a.txt::$DATA`), segments ending in a dot or a space
 * (`.ssh.` opens `.ssh`), DOS device names (`NUL`, `COM1.txt`), 8.3 short names (`PROGRA~1`), wildcard
 * and control characters, and device namespaces (`\\.\`, `\\?\GLOBALROOT`). Drive-relative (`C:x`)
 * and root-relative (`\x`) paths are not absolute.
 */

export class HostPathError extends Error {
  override readonly name = "HostPathError";
}

export type HostPathFlavor = "posix" | "win32";

const DRIVE_ABS = /^[A-Za-z]:[\\/]/;
const UNC = /^[\\/]{2}(?![.?][\\/])[^\\/]+[\\/][^\\/]+/;
const DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)(?:\..*)?$/i;
const SHORT_NAME = /^[^~.\\/]{1,6}~[0-9]+(?:\.[^.\\/]{0,3})?$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const BAD_CHARS = /[<>"|?*\u0000-\u001f]/;

/** Whether `p` is in Windows host form (drive or UNC), whatever the platform. */
export function isWin32HostPath(p: string): boolean {
  return /^[A-Z]:\\/.test(p) || p.startsWith("\\\\");
}

/** The flavor of a canonical host path. */
export function hostPathFlavor(p: string): HostPathFlavor {
  return isWin32HostPath(p) ? "win32" : "posix";
}

/**
 * Whether `p` names an absolute host path on `platform`: `/…` everywhere, and on Windows also a
 * drive path or a UNC share (including their `\\?\` forms).
 */
export function isAbsoluteHostPath(
  p: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (p.startsWith("/") && (platform !== "win32" || !p.startsWith("//"))) return true;
  if (platform !== "win32") return false;
  const s = stripLongPrefix(p);
  return s !== undefined && (DRIVE_ABS.test(s) || UNC.test(s));
}

/** `\\?\C:\x` → `C:\x`, `\\?\UNC\srv\share` → `\\srv\share`; other device paths → undefined. */
function stripLongPrefix(p: string): string | undefined {
  const m = /^[\\/]{2}([.?])[\\/]/.exec(p) ?? /^\\\?\?\\/.exec(p);
  if (m === null) return p;
  const rest = p.slice(m[0].length);
  if (DRIVE_ABS.test(rest)) return rest;
  if (/^UNC[\\/]/i.test(rest)) return `\\\\${rest.slice(4)}`;
  return undefined;
}

/**
 * The normalized absolute form of a host path, `..` resolved. POSIX paths keep today's rules on
 * every platform; Windows forms are accepted on Windows only. Throws `HostPathError` for anything
 * that is not absolute or that Win32 would rewrite (see the module comment).
 */
export function canonicalHostPath(
  input: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (input.includes("\0")) throw new HostPathError("NUL in path");
  if (input.startsWith("/") && (platform !== "win32" || !input.startsWith("//"))) {
    const p = posix.normalize(input);
    return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
  }
  if (platform !== "win32" || !isAbsoluteHostPath(input, platform)) {
    throw new HostPathError(`path is not absolute: ${JSON.stringify(input)}`);
  }
  const s = (stripLongPrefix(input) ?? "").replaceAll("/", "\\");
  const unc = s.startsWith("\\\\");
  const body = unc ? s.slice(2) : s.slice(3);
  const segments = body.split("\\");
  segments.forEach((seg, i) => {
    if (seg === "" || seg === "." || seg === "..") return;
    if (seg.includes(":"))
      throw new HostPathError(
        `alternate data streams are not file paths: ${JSON.stringify(input)}`,
      );
    if (BAD_CHARS.test(seg))
      throw new HostPathError(`invalid character in path: ${JSON.stringify(input)}`);
    if (/[. ]$/.test(seg))
      throw new HostPathError(
        `a name may not end in a dot or a space on Windows: ${JSON.stringify(input)}`,
      );
    // The server and share of a UNC path are not file names.
    if (unc && i < 2) return;
    if (DEVICE_NAME.test(seg))
      throw new HostPathError(`DOS device names are not file paths: ${JSON.stringify(input)}`);
    if (SHORT_NAME.test(seg))
      throw new HostPathError(
        `use the long name, not the 8.3 short name: ${JSON.stringify(input)}`,
      );
  });
  if (unc && (segments[0] === "" || segments[1] === undefined || segments[1] === "")) {
    throw new HostPathError(`a UNC path names a server and a share: ${JSON.stringify(input)}`);
  }
  let p = win32.normalize(s);
  if (unc) {
    // `..` never climbs out of the share.
    const [server = "", share = ""] = segments;
    const root = `\\\\${server}\\${share}`;
    if (!foldedUnder(p, root, "win32")) p = root;
    if (p.endsWith("\\") && p.length > root.length) p = p.slice(0, -1);
    if (p === `${root}\\`) p = root;
    return p;
  }
  p = `${p.charAt(0).toUpperCase()}${p.slice(1)}`;
  return p.length > 3 && p.endsWith("\\") ? p.slice(0, -1) : p;
}

/** Case folding for NTFS comparisons: one-to-one upper-casing, characters that grow left as they are. */
export function foldHostPath(p: string): string {
  if (!isWin32HostPath(p)) return p;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range test.
  if (/^[\u0000-\u007f]*$/.test(p)) return p.toUpperCase();
  let out = "";
  for (const ch of p) {
    const up = ch.toUpperCase();
    out += up.length === ch.length ? up : ch;
  }
  return out;
}

function foldedUnder(child: string, root: string, flavor: HostPathFlavor): boolean {
  const sep = flavor === "win32" ? "\\" : "/";
  const c = flavor === "win32" ? foldHostPath(child) : child;
  const r = flavor === "win32" ? foldHostPath(root) : root;
  if (r.endsWith(sep)) return c.startsWith(r);
  return c === r || c.startsWith(`${r}${sep}`);
}

/**
 * `child` equals `root` or lies under it, by whole segments (`C:\Docs2` is not under `C:\Docs`).
 * Both are canonical host paths; Windows forms compare without case. Mixed forms never match.
 */
export function isUnderHostPath(child: string, root: string): boolean {
  const flavor = hostPathFlavor(root);
  if (hostPathFlavor(child) !== flavor) return false;
  if (flavor === "posix" && root === "/") return child.startsWith("/");
  return foldedUnder(child, root, flavor);
}

/** Two canonical host paths name the same location (Windows forms without case). */
export function sameHostPath(a: string, b: string): boolean {
  return hostPathFlavor(a) === hostPathFlavor(b) && foldHostPath(a) === foldHostPath(b);
}

/** Joins segments (written with `/`) onto a canonical host path, in that path's form. */
export function joinHostPath(root: string, ...segments: string[]): string {
  return hostPathFlavor(root) === "win32"
    ? win32.join(root, ...segments)
    : posix.join(root, ...segments);
}

/** `child` relative to `root` with `/` separators (`""` for the root itself); `child` must be under it. */
export function relativeHostPath(root: string, child: string): string {
  const sep = hostPathFlavor(root) === "win32" ? "\\" : "/";
  if (sameHostPath(root, child)) return "";
  const start = root.endsWith(sep) ? root.length : root.length + 1;
  return child.slice(start).split(sep).join("/");
}

/** The path with `/` separators, as policy globs are written (`C:/Users/o/.ssh/id`). */
export function slashHostPath(p: string): string {
  return isWin32HostPath(p) ? p.replaceAll("\\", "/") : p;
}
