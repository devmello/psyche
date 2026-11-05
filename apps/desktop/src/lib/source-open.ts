import { realpathSync, statSync } from "node:fs";
import { isAbsolute, parse, sep } from "node:path";
import { IPC, IpcPayloadError, rec, str } from "./ipc.ts";

/**
 * Opens the original of a cited passage (docs/roadmap/future-features.md §1, phase 2), and nothing
 * else. This is an allowlisted opener, not a loosened link policy: `message:` and `file:` stay
 * refused by `checkExternalUrl` and the window's navigation rules.
 *
 * The renderer sends a search document id and nothing more. Main asks the Gateway what that
 * document may open (`search.openSource`, resolved from the index, never from renderer or model
 * text), then checks the answer again here before it acts:
 *
 * - Mail: a Message-ID of strict RFC 5322 shape becomes `message://%3C<id>%3E`, opened with
 *   `shell.openExternal`. The URL is built here and re-checked against one pattern.
 * - Files: reveal in Finder (`shell.showItemInFolder`, which never runs the file) for a regular
 *   file whose real path (symlinks followed) is inside one of the granted folders' real paths.
 *   `shell.openPath` is never used, so a script or app in a granted folder is never launched.
 * - Anything else, or anything that fails a check: nothing is opened.
 */

const MAX_DOC_ID = 400;

/** The renderer's request: one search document id. */
export function checkSourceOpen(v: unknown): { docId: string } {
  const docId = str(IPC.sourceOpen, rec(IPC.sourceOpen, v).docId, "docId", MAX_DOC_ID);
  // `mail:123`, `files:/Users/me/a.md`, `memory:fact:...`: a source name, a colon, then text with
  // no control characters.
  const control = [...docId].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
  if (control || !/^[a-z]{3,20}:.+$/.test(docId))
    throw new IpcPayloadError(IPC.sourceOpen, "docId is not a document id");
  return { docId };
}

// RFC 5322 msg-id (no brackets): dot-atom "@" dot-atom, domain of letters, digits, `-` and `_`.
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const MESSAGE_ID = new RegExp(`^${ATEXT}(?:\\.${ATEXT})*@[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*$`);
const MAIL_URL = /^message:\/\/%3C[A-Za-z0-9%._~-]{3,1500}%3E$/;

/** `message://%3C<id>%3E` for a well-formed Message-ID (brackets stripped), else undefined. */
export function mailUrl(messageId: unknown): string | undefined {
  if (typeof messageId !== "string") return undefined;
  const id =
    messageId.startsWith("<") && messageId.endsWith(">") ? messageId.slice(1, -1) : messageId;
  if (id.length === 0 || id.length > 254 || !MESSAGE_ID.test(id)) return undefined;
  const url = `message://%3C${encodeURIComponent(id).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}%3E`;
  return MAIL_URL.test(url) ? url : undefined;
}

export interface SourceOpenFs {
  realpath(path: string): string;
  isFile(path: string): boolean;
}

const nodeFs: SourceOpenFs = {
  // The native form asks the OS, so case folding and symlinks resolve as the file system does.
  realpath: (p) => realpathSync.native(p),
  isFile: (p) => statSync(p).isFile(),
};

const real = (fs: SourceOpenFs, p: string): string | undefined => {
  try {
    return fs.realpath(p);
  } catch {
    return undefined;
  }
};

const inside = (child: string, root: string): boolean =>
  child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * An absolute path on this OS (`/…` on macOS, `C:\…` or `\\server\share\…` on Windows), never
 * a Windows device path (`\\?\`, `\\.\`) and never with a NUL.
 */
function absoluteLocal(p: unknown, platform = process.platform): p is string {
  if (typeof p !== "string" || p.includes("\0")) return false;
  if (platform !== "win32") return p.startsWith("/");
  return isAbsolute(p) && !/^[\\/]{2}[?.][\\/]/.test(p) && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(p);
}

/**
 * The real path of `path` when it is an existing regular file inside one of `roots` (granted
 * folders, resolved too, so a link from inside to outside does not pass). Undefined otherwise.
 */
export function grantedFilePath(
  path: unknown,
  roots: unknown,
  fs: SourceOpenFs = nodeFs,
): string | undefined {
  if (!absoluteLocal(path)) return undefined;
  if (!Array.isArray(roots) || roots.length === 0 || roots.length > 64) return undefined;
  const realRoots = roots.flatMap((r) => {
    const x = absoluteLocal(r) ? real(fs, r) : undefined;
    // A volume root (`/`, `C:\`) is never a granted folder.
    return x === undefined || x === parse(x).root ? [] : [x];
  });
  const file = real(fs, path);
  if (file === undefined || !realRoots.some((r) => inside(file, r))) return undefined;
  try {
    return fs.isFile(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

export type SourceOpenResult = "mail" | "file" | "none";

export interface SourceOpenDeps {
  /** `search.openSource` through the Gateway connection (main's own, never the renderer's). */
  call: (docId: string) => Promise<unknown>;
  openExternal: (url: string) => Promise<void> | void;
  showItemInFolder: (path: string) => void;
  fs?: SourceOpenFs;
}

/**
 * Opens the original of `docId` if the Gateway names a target and the target passes the checks
 * above. "none" means nothing was opened (no target, or one that failed a check): the viewer's
 * text is the fallback.
 */
export async function openSource(docId: string, deps: SourceOpenDeps): Promise<SourceOpenResult> {
  const answer = await deps.call(docId);
  const target = rec("search.openSource", answer).target;
  if (target === null || target === undefined) return "none";
  const t = rec("search.openSource", target);
  if (t.kind === "mail") {
    const url = mailUrl(t.messageId);
    if (url === undefined) return "none";
    await deps.openExternal(url);
    return "mail";
  }
  if (t.kind === "file") {
    const path = grantedFilePath(t.path, t.roots, deps.fs);
    if (path === undefined) return "none";
    deps.showItemInFolder(path);
    return "file";
  }
  return "none";
}
