/**
 * Host paths for display and filtering in the UI (no file system access, no `node:path`: the kit
 * runs in a browser). The Gateway's host may be a Mac (`/Users/ada/Docs`) or a PC (`C:\Users\ada\Docs`,
 * `\\server\share\dir`), whatever the platform the UI renders on, so the form is read from the path
 * itself, as `@psyche/hostfs` does: a drive or UNC path is a Windows path, anything else is POSIX.
 * Windows paths split on `\` and `/` and are shown with `\`; POSIX paths keep `/`.
 */

export type PathFlavor = "posix" | "win32";

const DRIVE = /^[A-Za-z]:/;
const DRIVE_ABS = /^[A-Za-z]:[\\/]/;
const UNC = /^[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+/;

/** `\\?\C:\x` → `C:\x`, `\\?\UNC\srv\share` → `\\srv\share`; anything else unchanged. */
function stripLongPrefix(p: string): string {
  const m = /^[\\/]{2}[?.][\\/]/.exec(p);
  if (m === null) return p;
  const rest = p.slice(m[0].length);
  if (DRIVE_ABS.test(rest)) return rest;
  if (/^UNC[\\/]/i.test(rest)) return `\\\\${rest.slice(4)}`;
  return p;
}

/** Which form a path is in: a drive (`C:`), UNC (`\\srv`) or `\`-separated path is Windows. */
export function pathFlavor(p: string): PathFlavor {
  if (DRIVE.test(p) || /^[\\/]{2}/.test(p)) return "win32";
  if (p.startsWith("/")) return "posix";
  return p.includes("\\") ? "win32" : "posix";
}

/** `/x` everywhere; a drive path (`C:\x`, `C:/x`) or a UNC share (`\\srv\share`, `\\?\C:\x`). */
export function isAbsolutePath(p: string): boolean {
  if (p.startsWith("/") && !p.startsWith("//")) return true;
  const s = stripLongPrefix(p);
  return DRIVE_ABS.test(s) || UNC.test(s);
}

/** The root a path keeps when trimmed: `/`, `C:\`, `\\srv\share\`; "" for a relative path. */
function rootOf(p: string): string {
  if (pathFlavor(p) === "posix") return p.startsWith("/") ? "/" : "";
  const drive = /^[A-Za-z]:[\\/]?/.exec(p);
  if (drive) return drive[0];
  const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?/.exec(p);
  if (unc) return unc[0];
  return /^[\\/]/.test(p) ? p.slice(0, 1) : "";
}

const SEP: Record<PathFlavor, RegExp> = { posix: /\//, win32: /[\\/]/ };

function parts(p: string): { root: string; segments: string[]; flavor: PathFlavor } {
  const s = stripLongPrefix(p);
  const flavor = pathFlavor(s);
  const raw = rootOf(s);
  const root = flavor === "win32" ? raw.replaceAll("/", "\\") : raw;
  const segments = s
    .slice(raw.length)
    .split(SEP[flavor])
    .filter((x) => x !== "");
  return { root, segments, flavor };
}

/** "Downloads" for `/Users/me/Downloads/` or `C:\Users\me\Downloads`; a root names itself. */
export function pathBasename(p: string): string {
  const { root, segments } = parts(p);
  return segments.at(-1) ?? (root !== "" ? root : p);
}

/** `/Users/me` for `/Users/me/Downloads`, `C:\Users` for `C:\Users\me`; a root is its own parent. */
export function pathDirname(p: string): string {
  const { root, segments, flavor } = parts(p);
  if (segments.length <= 1) return root !== "" ? root : ".";
  const sep = flavor === "win32" ? "\\" : "/";
  return root + segments.slice(0, -1).join(sep);
}

/** `base` + names with the base's separator: `C:\Docs` + `a.txt` → `C:\Docs\a.txt`. */
export function joinPath(base: string, ...names: string[]): string {
  const { root, segments, flavor } = parts(base);
  const sep = flavor === "win32" ? "\\" : "/";
  const all = [...segments, ...names.flatMap((n) => n.split(SEP[flavor]))].filter((x) => x !== "");
  if (all.length === 0) return root !== "" ? root : base;
  // A UNC root without its trailing separator (`\\srv\share`) still needs one before a name.
  const head = root === "" || /[\\/]$/.test(root) ? root : root + sep;
  return head + all.join(sep);
}

/**
 * A path for labels: Windows paths with `\` (a `C:/x` from a tool reads `C:\x`), long-path
 * prefixes dropped, and the home folder shortened to `~` (`/Users/ada/Docs` → `~/Docs`,
 * `C:\Users\ada\Docs` → `~\Docs`). Tooltips keep the full path.
 */
export function displayPath(p: string): string {
  const s = stripLongPrefix(p);
  if (pathFlavor(s) === "posix") return s.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
  return s.replaceAll("/", "\\").replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/i, "~");
}
