import { realpathSync, statSync } from "node:fs";
import { parse, sep } from "node:path";

/**
 * What it takes to open a source passage outside Psyche (docs/roadmap/future-features.md §1,
 * phase 2). Nothing here opens anything: it decides which targets are safe to hand to the
 * desktop, from what the index holds. The desktop checks the same shapes again before it acts
 * (`apps/desktop/src/lib/source-open.ts`); the two are kept apart on purpose.
 */

/** Longest Message-ID kept (RFC 5322 says 998 per line; real ones are far shorter). */
export const MAX_MESSAGE_ID_CHARS = 254;

// RFC 5322 `msg-id` without the brackets: dot-atom-text "@" dot-atom-text. The domain part is
// letters, digits, hyphen and underscore, so no `[literal]`, quoted string, whitespace, control
// character, `<` or `>` can pass. Anything else is not opened (the viewer shows the passage).
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const MESSAGE_ID = new RegExp(`^${ATEXT}(?:\\.${ATEXT})*@[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*$`);

/** The Message-ID in `raw` (angle brackets allowed, one pair at most), or undefined when it is not one. */
export function parseMessageId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let id = raw;
  if (id.startsWith("<") && id.endsWith(">")) id = id.slice(1, -1);
  if (id.length === 0 || id.length > MAX_MESSAGE_ID_CHARS) return undefined;
  return MESSAGE_ID.test(id) ? id : undefined;
}

/** `message://%3Cid%40host%3E` (what Apple Mail's tools return as `link`) → the Message-ID. */
export function messageIdFromLink(link: unknown): string | undefined {
  if (typeof link !== "string") return undefined;
  const m = /^message:\/\/([^/?#]{1,1024})$/i.exec(link.trim());
  if (m?.[1] === undefined) return undefined;
  try {
    return parseMessageId(decodeURIComponent(m[1]));
  } catch {
    return undefined;
  }
}

/** A file that may be shown in Finder: its real path and the real paths of the granted folders. */
export interface GrantedFile {
  path: string;
  roots: string[];
}

const real = (p: string): string | undefined => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};

/** True when `child` is `root` or below it (both already real paths). */
export const isInside = (child: string, root: string): boolean =>
  child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * An absolute path: `/…`, and on Windows a drive (`C:\…`) or UNC (`\\server\share\…`) path. Not
 * Windows' root-relative `\x` or drive-relative `C:x`, which depend on the current drive or folder.
 */
const absolute = (p: string): boolean =>
  process.platform === "win32"
    ? /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/.?]/.test(p)
    : p.startsWith("/");

/**
 * `path` resolved to its real path (symlinks followed), when it is an existing regular file inside
 * one of the folders currently granted (also resolved). A link that leaves a granted folder, a
 * path with a NUL, a relative path, a folder and a file that is gone all give undefined. A file
 * system root (`/`, `C:\`, a UNC share's root) is never a granted folder. Real paths come from the
 * file system with its own spelling, so the comparison stays exact on Windows too.
 */
export function resolveGrantedFile(
  path: unknown,
  grantedFolders: readonly string[],
): GrantedFile | undefined {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) return undefined;
  if (!absolute(path) || path.includes("\0")) return undefined;
  const roots = [
    ...new Set(
      grantedFolders.flatMap((f) => {
        const r = absolute(f) && !f.includes("\0") ? real(f) : undefined;
        return r === undefined || parse(r).root === r ? [] : [r];
      }),
    ),
  ];
  const file = real(path);
  if (file === undefined || !roots.some((r) => isInside(file, r))) return undefined;
  try {
    if (!statSync(file).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return { path: file, roots };
}
