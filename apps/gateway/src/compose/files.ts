import { constants } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  assertGranted,
  assertNoSymlinks,
  canonicalTarget,
  fsError,
  type GrantedFolder,
  isUnder,
} from "@psyche/files";
import {
  FILE_CHUNK_BYTES,
  FILE_LIST_PAGE,
  type FileEntry,
  type MethodParams,
  type MethodResult,
  PsycheError,
} from "@psyche/protocol";
import { mimeFromName } from "@psyche/viewers/core/detect";
import type { Call, HandlerDef } from "../context.ts";

/**
 * `files.list` and `files.read` (feature P4; UI design §3.7): read-only access for the Files pane
 * and the viewers. A path must lie in a folder the owner granted (`permissions.policy.folders`)
 * and go through no symlink, the same checks the agent's file tools make (@psyche/files); a
 * `libraryPath` must stay inside `$PSYCHE_HOME/library`. Bytes go out in base64 chunks of at
 * most FILE_CHUNK_BYTES so every frame stays under MAX_FRAME_BYTES.
 */

export interface FilesSetup {
  /** The granted folders, read on every call so a revoked grant applies at once. */
  folders: () => readonly GrantedFolder[];
  /** `$PSYCHE_HOME`; the Library is its `library/` folder. */
  home: string;
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

async function listFolder(
  params: MethodParams<"files.list">,
  setup: FilesSetup,
): Promise<MethodResult<"files.list">> {
  const dir = canonicalTarget(params.path);
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
    const info = await fh.stat();
    const chunk = await readChunk(fh, info.size, params.offset, params.length);
    return {
      name: source.name,
      mime: mimeFromName(source.name) ?? "application/octet-stream",
      modifiedAt: info.mtime.toISOString(),
      etag: etagOf(info),
      ...chunk,
    };
  } finally {
    await fh.close();
  }
}

/** The handlers, for the dispatcher. */
export function filesHandlers(setup: FilesSetup): Record<string, HandlerDef> {
  return {
    "files.list": {
      run: (_call: Call, params: MethodParams<"files.list">) => listFolder(params, setup),
    },
    "files.read": {
      run: (_call: Call, params: MethodParams<"files.read">) => readFile(params, setup),
    },
  };
}
