import { randomBytes } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { HashChainAuditLog } from "@psyche/audit";
import { getAgentThreadState, getThread, listRuns } from "@psyche/db";
import {
  assertGranted,
  assertNoSymlinks,
  assertNotProtected,
  canonicalTarget,
  fsError,
  type GrantedFolder,
  isUnder,
} from "@psyche/files";
import { sameHostPath } from "@psyche/hostfs";
import { assertFolderGrantable, folderCovers } from "@psyche/permissions";
import {
  FILE_CHUNK_BYTES,
  FILE_LIST_PAGE,
  FILE_WRITE_EXTENSIONS,
  FILE_WRITE_MAX_BYTES,
  type FileEntry,
  type MethodParams,
  type MethodResult,
  PsycheError,
  type TaintSource,
} from "@psyche/protocol";
import { mimeFromName } from "@psyche/viewers/core/detect";
import type { Call, HandlerDef } from "../context.ts";
import { type FolderAccessToolDeps, requestFolderShare } from "./folder-access.ts";
import {
  folderAccessEnv,
  ownerSaveProtectedRoots,
  protectedRoots,
  runCarveOuts,
} from "./protected-paths.ts";

/**
 * `files.list` and `files.read` (feature P4; UI design §3.7): read-only access for the Files pane
 * and the viewers. A path must lie in a folder the owner granted (`permissions.policy.folders`)
 * and go through no symlink, the same checks the agent's file tools make (@psyche/files); a
 * `libraryPath` must stay inside `$PSYCHE_HOME/library`. Psyche's own home and the owner's
 * credential stores are refused even under a granted folder (#285). Bytes go out in base64 chunks of at
 * most FILE_CHUNK_BYTES so every frame stays under MAX_FRAME_BYTES.
 */

export interface FilesSetup {
  /** The granted folders, read on every call so a revoked grant applies at once. */
  folders: () => readonly GrantedFolder[];
  /** `$PSYCHE_HOME`; the Library is its `library/` folder. */
  home: string;
  /** The owner's home directory (default: this user's); `files.starterFolders` looks under it. */
  userHome?: string;
  /** What `files.requestShare` raises its folder card with (the tool's broker and surfaces). */
  share?: FolderAccessToolDeps;
  /**  reports every save here; without it the method is unavailable. */
  audit?: Pick<HashChainAuditLog, "append">;
  /** Test seam: the rename that publishes a saved file. */
  rename?: (from: string, to: string) => Promise<void>;
}

/** A file the caller may read: its real path and display name. */
export interface FileSource {
  path: string;
  name: string;
}

/** Resolves `{path}` or `{libraryPath}` to a readable real path, or throws. */
export async function resolveFileSource(
  params: { path?: string; libraryPath?: string },
  setup: FilesSetup,
): Promise<FileSource> {
  const { path, libraryPath } = params;
  if ((path === undefined) === (libraryPath === undefined)) {
    throw new PsycheError("invalid_params", "pass exactly one of path and libraryPath");
  }
  if (path !== undefined) {
    const target = canonicalTarget(path);
    assertNotProtected(target, protectedRoots(setup.home), [], undefined, runCarveOuts());
    assertGranted(target, setup.folders(), "read");
    await assertNoSymlinks(target);
    return { path: target, name: basename(target) };
  }
  const relative = libraryPath as string;
  if (relative.includes("\0")) throw new PsycheError("invalid_params", "NUL in path");
  let root: string;
  try {
    root = await realpath(join(setup.home, "library"));
  } catch {
    throw new PsycheError("not_found", `${relative} is not in the Library`);
  }
  const target = resolve(root, relative);
  if (target === root || !isUnder(target, root)) {
    throw new PsycheError("forbidden", `${relative} is outside the Library`);
  }
  await assertNoSymlinks(target);
  return { path: target, name: basename(target) };
}

/** Opens a regular file without following a link swapped in after the checks. */
export async function openRegularFile(path: string): Promise<FileHandle> {
  let fh: FileHandle;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    throw fsError(err, path);
  }
  const info = await fh.stat();
  if (!info.isFile()) {
    await fh.close();
    throw new PsycheError("invalid_params", `${path} is not a file`);
  }
  return fh;
}

/** Reads `[offset, offset + length)` of an open file as a protocol chunk. */
export async function readChunk(
  fh: FileHandle,
  size: number,
  offset = 0,
  length = FILE_CHUNK_BYTES,
): Promise<{ size: number; offset: number; bytes: string; nextOffset: number | null }> {
  if (offset > size) throw new PsycheError("invalid_params", `offset ${offset} is past the end`);
  const want = Math.min(length, FILE_CHUNK_BYTES, size - offset);
  const buf = Buffer.alloc(want);
  let got = 0;
  while (got < want) {
    const { bytesRead } = await fh.read(buf, got, want - got, offset + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  const end = offset + got;
  return {
    size,
    offset,
    bytes: buf.subarray(0, got).toString("base64"),
    nextOffset: end < size ? end : null,
  };
}

/** Size and modification time, so a reader notices a file that changed between chunks. */
export const etagOf = (info: { size: number; mtimeMs: number }): string =>
  `${info.size.toString(36)}-${Math.trunc(info.mtimeMs).toString(36)}`;

/**
 * What `files.read` returns as the etag and `files.write` matches: size, mtime and ctime in
 * nanoseconds, and the inode. ctime cannot be set from userland, so a same-size edit that put
 * the old mtime back (`utimes`, `cp -p`, `rsync -t`) still changes it.
 */
export const fileEtag = (info: BigIntStats): string =>
  [info.size, info.mtimeNs, info.ino, info.ctimeNs].map((n) => n.toString(36)).join("-");

async function listFolder(
  params: MethodParams<"files.list">,
  setup: FilesSetup,
): Promise<MethodResult<"files.list">> {
  const dir = canonicalTarget(params.path);
  const roots = protectedRoots(setup.home);
  assertNotProtected(dir, roots, [], undefined, runCarveOuts());
  assertGranted(dir, setup.folders(), "read");
  await assertNoSymlinks(dir);
  let names: import("node:fs").Dirent[];
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw fsError(err, dir);
  }
  const entries: FileEntry[] = [];
  for (const d of names) {
    const path = join(dir, d.name);
    // A protected folder under a granted one (`~/.psyche`, `~/.ssh`) is not even listed.
    if (roots.some((r) => path === r)) continue;
    const kind = d.isDirectory() ? "folder" : d.isFile() ? "file" : "other";
    let size: number | null = null;
    let modifiedAt: string | null = null;
    if (kind !== "other") {
      try {
        const info = await lstat(path);
        size = kind === "file" ? info.size : null;
        modifiedAt = info.mtime.toISOString();
      } catch {
        // Gone since readdir; list it without details.
      }
    }
    entries.push({ name: d.name, path, kind, size, modifiedAt });
  }
  const rank = (k: FileEntry["kind"]) => (k === "folder" ? 0 : k === "file" ? 1 : 2);
  entries.sort((a, b) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name));
  const offset = params.offset ?? 0;
  const page = entries.slice(offset, offset + FILE_LIST_PAGE);
  const next = offset + page.length;
  return { entries: page, nextOffset: next < entries.length ? next : null };
}

async function readFile(
  params: MethodParams<"files.read">,
  setup: FilesSetup,
): Promise<MethodResult<"files.read">> {
  const source = await resolveFileSource(params, setup);
  const fh = await openRegularFile(source.path);
  try {
    const info = await fh.stat({ bigint: true });
    const chunk = await readChunk(fh, Number(info.size), params.offset, params.length);
    return {
      name: source.name,
      mime: mimeFromName(source.name) ?? "application/octet-stream",
      modifiedAt: info.mtime.toISOString(),
      etag: fileEtag(info),
      ...chunk,
    };
  } finally {
    await fh.close();
  }
}

/**
 * `files.write`: the owner's own edit of a text file from the Files pane (admin devices only, no
 * approval card). The same gates as the agent's write, minus the card: a folder shared `rw`
 * (policy folders only: a single attached file or a read-only folder never qualifies), no symlink,
 * outside Psyche's home and the credential stores, an allowlisted extension, a size cap that keeps
 * the request under the frame limit. The save replaces a file that exists and needs the etag the
 * reader holds; it goes through a temp file and a rename, after a last look at the folder.
 */
async function writeFile(
  call: Call,
  params: MethodParams<"files.write">,
  setup: FilesSetup,
): Promise<MethodResult<"files.write">> {
  if (!call.identity.scopes.includes("operator.admin")) {
    throw new PsycheError("forbidden", "saving a file requires operator.admin");
  }
  if (setup.audit === undefined) throw new PsycheError("unavailable", "saving is not set up");
  const target = canonicalTarget(params.path);
  try {
    return await saveFile(call, params, setup, target, setup.audit);
  } catch (err) {
    // ENAMETOOLONG and the like become errors the owner can read.
    throw fsError(err, target);
  }
}

async function saveFile(
  call: Call,
  params: MethodParams<"files.write">,
  setup: FilesSetup,
  target: string,
  audit: NonNullable<FilesSetup["audit"]>,
): Promise<MethodResult<"files.write">> {
  const ext = extname(target).toLowerCase();
  if (!(FILE_WRITE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new PsycheError(
      "invalid_params",
      `only ${FILE_WRITE_EXTENSIONS.join(", ")} files can be saved here`,
    );
  }
  const { content } = params;
  if (content.includes("\0") || !content.isWellFormed()) {
    throw new PsycheError("invalid_params", "only UTF-8 text can be saved");
  }
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > FILE_WRITE_MAX_BYTES) {
    throw new PsycheError(
      "invalid_params",
      `the file is larger than ${FILE_WRITE_MAX_BYTES} bytes`,
    );
  }
  const roots = protectedRoots(setup.home);
  // The owner's own save: Psyche's home and the credential stores stay out of reach, the agent's
  // `~/Library` and dot-entry rules do not apply (#1434 review r1, finding 5).
  const own = ownerSaveProtectedRoots(setup.userHome);
  // Policy folders only; the longest root decides. Run again right before the swap.
  const checkGrant = (path: string) => {
    const folders = setup.folders().filter((f) => f.file !== true);
    assertNotProtected(path, roots, [], own, runCarveOuts());
    assertGranted(path, folders, "write");
  };
  checkGrant(target);
  await assertNoSymlinks(target);

  const dir = dirname(target);
  const current = await lstat(target, { bigint: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw fsError(err, target);
  });
  if (current === undefined) throw new PsycheError("not_found", `${target} does not exist`);
  if (!current.isFile()) throw new PsycheError("invalid_params", `${target} is not a file`);
  if (current.nlink !== 1n) {
    throw new PsycheError("forbidden", `${target} has another name; it can't be saved here`);
  }
  const mode = Number(current.mode & 0o777n);
  if ((mode & 0o200) === 0) {
    throw new PsycheError(
      "forbidden",
      `${basename(target)} is read only on disk; change its permissions first`,
    );
  }
  if (params.ifMatch !== fileEtag(current)) {
    throw new PsycheError("conflict", `${target} changed since you opened it`);
  }

  const tmp = join(dir, `.psyche-${randomBytes(6).toString("hex")}.tmp`);
  const moved = () => new PsycheError("forbidden", `${dir} changed while it was being saved`);
  const fh = await open(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  // The temp file's own inode: once it is the target, the save has happened.
  let written: { dev: bigint; ino: bigint } | undefined;
  let renameTried = false;
  const isOurs = async (): Promise<boolean> => {
    if (written === undefined) return false;
    const at = await lstat(target, { bigint: true }).catch(() => undefined);
    return at !== undefined && at.dev === written.dev && at.ino === written.ino;
  };
  try {
    await fh.writeFile(bytes);
    await fh.chmod(mode);
    await fh.sync();
    written = await fh.stat({ bigint: true });
    // The last look before the swap. Every step above went through the folder's path, so a
    // folder swapped for a link meanwhile must not take the rename outside the grant.
    if (!sameHostPath(await realpath(dir), dir)) throw moved();
    const placed = await lstat(tmp, { bigint: true });
    if (!placed.isFile() || placed.dev !== written.dev || placed.ino !== written.ino) {
      throw moved();
    }
    checkGrant(join(dir, basename(target)));
    const now = await lstat(target, { bigint: true }).catch(() => undefined);
    if (now === undefined || !now.isFile() || fileEtag(now) !== params.ifMatch) {
      throw new PsycheError("conflict", `${target} changed since you opened it`);
    }
    try {
      renameTried = true;
      await (setup.rename ?? rename)(tmp, target);
    } catch (err) {
      // A rename whose reply was lost (NFS, SMB retry) can report ENOENT after it happened: if
      // the target is now our inode, the save went through.
      if (!(await isOurs())) {
        // The folder was swapped between the checks and the rename: the temp name is gone.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw moved();
        throw err;
      }
    }
  } catch (err) {
    // Never empty the inode that is now the owner's saved file.
    if (!(await isOurs())) {
      // Empty the file through its own descriptor, which a swapped path cannot redirect, so a
      // temp file stranded in a moved folder holds none of the owner's text; then remove it.
      // Once a rename was tried the inode may already be the owner's file (a filesystem whose
      // inode numbers are not stable, like smbfs without file IDs, can hide that), so then it is
      // emptied only when the folder really moved.
      const swapped = !sameHostPath(await realpath(dir).catch(() => ""), dir);
      if (!renameTried || swapped) await fh.truncate(0).catch(() => undefined);
      await unlink(tmp).catch(() => undefined);
    }
    throw err;
  } finally {
    await fh.close().catch(() => undefined);
  }
  const info = await lstat(target, { bigint: true });
  // The path and the size only: never what was written.
  await audit.append({
    kind: "files.write",
    actor: { type: "device", deviceId: call.identity.deviceId },
    data: { path: target, bytes: bytes.length },
  });
  return { etag: fileEtag(info), modifiedAt: info.mtime.toISOString(), size: Number(info.size) };
}

const STARTER_FOLDERS = [
  ["documents", "Documents"],
  ["desktop", "Desktop"],
  ["downloads", "Downloads"],
] as const;

/** Case-insensitive volumes (macOS, Windows) treat `documents` and `Documents` as one folder. */
const FOLDS_CASE = process.platform === "darwin" || process.platform === "win32";

const realOr = async (p: string): Promise<string> => realpath(p).catch(() => p);

/**
 * A granted folder already covers `path`: compared on real paths (realpath fixes the case of
 * what exists) and, on a case-insensitive volume, without case for what does not.
 */
async function alreadyShared(grants: readonly GrantedFolder[], path: string): Promise<boolean> {
  const real = await realOr(path);
  const realGrants = await Promise.all(
    grants.map(async (g) => ({ ...g, path: await realOr(g.path) })),
  );
  if (folderCovers(realGrants, real, "ro") !== undefined) return true;
  if (!FOLDS_CASE) return false;
  const c = real.toLowerCase();
  return realGrants.some((g) => {
    const a = g.path.toLowerCase().replace(/[\\/]+$/, "");
    return c === a || c.startsWith(a + sep);
  });
}

/**
 * Documents, Desktop and Downloads for the onboarding step: only an existing folder that
 * `assertFolderGrantable` accepts and no granted folder covers yet. Nothing is granted here.
 */
async function starterFolders(setup: FilesSetup): Promise<MethodResult<"files.starterFolders">> {
  const userHome = setup.userHome ?? homedir();
  const folders: MethodResult<"files.starterFolders">["folders"] = [];
  for (const [id, name] of STARTER_FOLDERS) {
    const path = join(userHome, name);
    try {
      if (!(await lstat(path)).isDirectory()) continue;
      await assertFolderGrantable(path, { ...folderAccessEnv(setup.home), home: userHome });
    } catch {
      continue;
    }
    if (await alreadyShared(setup.folders(), path)) continue;
    folders.push({ id, path });
  }
  return { folders };
}

/** The handlers, for the dispatcher. */
/**
 * `files.requestShare`: the chat's share button. Admin devices only, read only, and it only
 * raises the folder card: the owner's pick on the card is what is granted. The thread's taint
 * comes from the Gateway (its saved state, or a turn still running, whose taint is not saved
 * yet), never from the client.
 */
async function requestShare(
  call: Call,
  params: MethodParams<"files.requestShare">,
  setup: FilesSetup,
): Promise<MethodResult<"files.requestShare">> {
  if (!call.identity.scopes.includes("operator.admin")) {
    throw new PsycheError("forbidden", "sharing a folder requires operator.admin");
  }
  if ((params.access as string) !== "read") {
    throw new PsycheError("invalid_params", "this button shares a folder read only");
  }
  if (setup.share === undefined) throw new PsycheError("unavailable", "sharing is not set up");
  const thread = getThread(call.ctx.db, params.threadId);
  if (thread === undefined) {
    throw new PsycheError("not_found", `thread ${params.threadId} not found`);
  }
  // An owner share belongs to the owner's own conversations. A channel thread's turns can come
  // from other senders, and a subagent thread belongs to its parent's run.
  if (thread.kind === "channel" || thread.kind === "subagent") {
    throw new PsycheError("forbidden", "a folder can't be shared from this kind of conversation");
  }
  const saved = getAgentThreadState(call.ctx.db, params.threadId)?.taint as
    | { sources?: TaintSource[] }
    | undefined;
  const turnRunning = listRuns(call.ctx.db, { threadId: params.threadId, limit: 20 }).some(
    (r) => r.status !== "done" && r.status !== "failed" && r.status !== "cancelled",
  );
  const taint = saved !== undefined || turnRunning;
  return requestFolderShare(setup.share, {
    threadId: params.threadId,
    path: params.path,
    taint,
    unattended: thread.kind === "automation",
    ...(saved?.sources === undefined ? {} : { taintSources: saved.sources }),
  });
}

export function filesHandlers(setup: FilesSetup): Record<string, HandlerDef> {
  return {
    "files.starterFolders": { run: () => starterFolders(setup) },
    "files.requestShare": {
      run: (call: Call, params: MethodParams<"files.requestShare">) =>
        requestShare(call, params, setup),
    },
    "files.list": {
      run: (_call: Call, params: MethodParams<"files.list">) => listFolder(params, setup),
    },
    "files.write": {
      run: (call: Call, params: MethodParams<"files.write">) => writeFile(call, params, setup),
    },
    "files.read": {
      run: (_call: Call, params: MethodParams<"files.read">) => readFile(params, setup),
    },
  };
}
