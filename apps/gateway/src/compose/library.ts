import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  FsQuarantineWriter,
  type LibraryImport,
  type QuarantinedFile,
  type RecordingImport,
  type SniffResult,
  safeFilename,
} from "@psyche/browser";
import type { LibraryIngest, LibraryIngestInput } from "@psyche/channels";
import type { LibrarySink } from "@psyche/connectors";
import {
  deleteLibraryItem,
  getLibraryItem,
  insertLibraryItem,
  listLibraryItemsPage,
  type NewLibraryItem,
  type PsycheDb,
  upsertLibraryItemByPath,
} from "@psyche/db";
import { assertNoSymlinks, fsError, isUnder } from "@psyche/files";
import {
  type LibraryItem,
  type MethodParams,
  type MethodResult,
  PsycheError,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_MAX_BYTES,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { decodeOffset, encodeOffset } from "../handlers/threads.ts";

/**
 * The Library (data model §9; feature P4): files under `$PSYCHE_HOME/library`, indexed in the
 * `library_items` table. Every writer the Gateway composes records what it saves here:
 * - channel attachments (`indexedChannelLibrary`) land in `quarantine/`, always quarantined;
 * - browser downloads (`IndexedQuarantineWriter`) land in `quarantine/`, always quarantined, and
 *   finished recordings are registered in place (`recordings/<id>`, one row per recording);
 * - read-aloud clips and voice memos (`FsAudioLibrary`, speech part) land in `audio/`.
 * `library.list` / `library.get` serve the index; `library.delete` removes the file and the row.
 * Bytes go out through `files.read {libraryPath}`.
 */

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

export const libraryRoot = (home: string): string => join(home, "library");

/** The Library kind a stored file gets from its (sniffed or declared) mime type. */
export function kindOfMime(mime: string): LibraryItem["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

/** A writer's path relative to the Library root, or null when it lies outside it. */
function libraryRelative(home: string, absolute: string): string | null {
  const rel = relative(libraryRoot(home), absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split("\\").join("/");
}

/** Index a file a writer just stored; on failure the file goes too, so no item is half-saved. */
async function indexOrRemove(db: PsycheDb, stored: string, item: NewLibraryItem) {
  try {
    return insertLibraryItem(db, item);
  } catch (err) {
    await rm(stored, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Channel attachments (S10 `LibraryIngest`): bytes under `quarantine/<id>-<name>`, mode 0600,
 * never opened or executed, indexed as quarantined with `origin: channel`.
 */
export function indexedChannelLibrary(db: PsycheDb, home: string): LibraryIngest {
  const dir = join(libraryRoot(home), "quarantine");
  return {
    async ingest(input: LibraryIngestInput) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const id = db.newId();
      const name = safeFilename(input.name);
      const stored = join(dir, `${id}-${name}`);
      await writeFile(stored, input.data, { mode: 0o600 });
      const item = await indexOrRemove(db, stored, {
        id,
        kind: kindOfMime(input.mime),
        name,
        mime: input.mime,
        path: `quarantine/${id}-${name}`,
        size: input.data.byteLength,
        sha256: `sha256:${createHash("sha256").update(input.data).digest("hex")}`,
        origin: "channel",
        tags: [input.source.channel],
        quarantined: true,
        source: { ...input.source, provenance: input.provenance },
      });
      return { libraryItemId: item.id };
    },
  };
}

/**
 * Connector attachments (S09 `LibrarySink`: Gmail, Drive, OneDrive, Mail attachments the Mac
 * helper staged): bytes under `quarantine/<id>-<name>`, mode 0600, never opened or executed,
 * indexed as quarantined with `origin: connector`.
 */
export function indexedConnectorLibrary(db: PsycheDb, home: string): LibrarySink {
  const dir = join(libraryRoot(home), "quarantine");
  return {
    async put(input) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const id = db.newId();
      const name = safeFilename(input.name);
      const stored = join(dir, `${id}-${name}`);
      await writeFile(stored, input.bytes, { mode: 0o600 });
      const item = await indexOrRemove(db, stored, {
        id,
        kind: kindOfMime(input.mimeType),
        name,
        mime: input.mimeType,
        path: `quarantine/${id}-${name}`,
        size: input.bytes.byteLength,
        sha256: `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`,
        origin: "connector",
        tags: [input.source.connectorId],
        quarantined: true,
        source: { ...input.source, provenance: input.provenance },
      });
      return { libraryItemId: item.id };
    },
  };
}

/** Total bytes of the regular files under a folder (a recording). */
async function folderSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}

/**
 * Browser downloads and recordings (S08 `LibraryWriter`): `FsQuarantineWriter` moves the file,
 * then the download is indexed as a quarantined `download`; a finished recording is indexed in
 * place as a `recording` (importing it again refreshes the same row).
 */
export class IndexedQuarantineWriter extends FsQuarantineWriter {
  readonly #db: PsycheDb;
  readonly #home: string;

  constructor(db: PsycheDb, home: string) {
    super(libraryRoot(home));
    this.#db = db;
    this.#home = home;
  }

  override async importDownload(file: QuarantinedFile, sniffed: SniffResult) {
    const imported: LibraryImport = await super.importDownload(file, sniffed);
    const stored = this.items.get(imported.libraryItemId);
    // The writer's own memory is only a stand-in for the index.
    this.items.delete(imported.libraryItemId);
    const path = stored === undefined ? null : libraryRelative(this.#home, stored.storedPath);
    if (stored === undefined || path === null) {
      throw new PsycheError("internal", "the download landed outside the Library");
    }
    await indexOrRemove(this.#db, stored.storedPath, {
      id: imported.libraryItemId,
      kind: "download",
      name: safeFilename(file.filename),
      mime: imported.mime,
      path,
      size: imported.size,
      sha256: imported.sha256,
      origin: "download",
      taskId: file.taskId ?? null,
      tags: [
        ...(imported.executable ? ["executable"] : []),
        ...(imported.mismatch ? ["mime-mismatch"] : []),
      ],
      quarantined: true,
      source: { url: file.sourceUrl, declaredMime: file.declaredMime },
    });
    return imported;
  }

  override async importRecording(recording: RecordingImport): Promise<{ libraryItemId: string }> {
    const path = libraryRelative(this.#home, recording.dir);
    if (path === null) return super.importRecording(recording);
    let index: Buffer = Buffer.alloc(0);
    try {
      index = await readFile(join(recording.dir, "index.json"));
    } catch {
      // A recording without its index still gets a row; the store reports it as unreadable.
    }
    const item = upsertLibraryItemByPath(this.#db, {
      kind: "recording",
      name: "Browser recording",
      mime: "inode/directory",
      path,
      size: await folderSize(recording.dir).catch(() => 0),
      sha256: `sha256:${createHash("sha256").update(index).digest("hex")}`,
      origin: "agent",
      threadId: recording.threadId,
      taskId: recording.taskId,
      tags: ["browser"],
      source: {
        recordingId: recording.id,
        frames: recording.frameCount,
        events: recording.eventCount,
      },
    });
    return { libraryItemId: item.id };
  }
}

/** Speech's audio writer hook: index each clip or memo it saved. */
export const indexSavedAudio =
  (db: PsycheDb) =>
  (item: LibraryItem): void => {
    insertLibraryItem(db, item);
  };

/** Removes an item's file (or recording folder) without leaving the Library or following links. */
async function removeStored(home: string, item: LibraryItem): Promise<void> {
  let root: string;
  try {
    root = await realpath(libraryRoot(home));
  } catch {
    return; // No Library folder: nothing on disk to remove.
  }
  const target = resolve(root, item.path);
  if (target === root || !isUnder(target, root)) {
    throw new PsycheError("forbidden", `${item.path} is outside the Library`);
  }
  await assertNoSymlinks(target);
  try {
    await rm(target, { recursive: item.kind === "recording", force: true });
  } catch (err) {
    throw fsError(err, item.path);
  }
}

export interface LibrarySetup {
  db: PsycheDb;
  /** `$PSYCHE_HOME`. */
  home: string;
}

function requireItem(db: PsycheDb, itemId: string): LibraryItem {
  const item = getLibraryItem(db, itemId);
  if (item === undefined) throw new PsycheError("not_found", `library item ${itemId} not found`);
  return item;
}

/** A chunked upload in progress (`library.upload`), staged on disk until its last chunk. */
interface Staged {
  deviceId: string;
  name: string;
  mime: string;
  threadId: string | null;
  file: string;
  size: number;
  touched: number;
}

/** A staged upload nobody finished is dropped after this long. */
const UPLOAD_STALE_MS = 10 * 60 * 1000;
/** Uploads one device may have in flight. */
const UPLOADS_PER_DEVICE = 8;

const EXTENSION_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
};

/** The declared mime type, else one from the extension, else opaque bytes. */
function uploadMime(declared: string | undefined, name: string): string {
  const d = declared?.trim().toLowerCase();
  if (d !== undefined && d !== "" && d !== "application/octet-stream") return d;
  return EXTENSION_MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** `library.list`, `library.get`, `library.upload`, `library.delete` (scopes from the protocol). */
export function libraryHandlers(setup: LibrarySetup): Record<string, HandlerDef> {
  const { db, home } = setup;
  const staged = new Map<string, Staged>();
  const dropStale = async (now: number) => {
    for (const [id, u] of staged) {
      if (now - u.touched < UPLOAD_STALE_MS) continue;
      staged.delete(id);
      await rm(u.file, { force: true }).catch(() => undefined);
    }
  };
  return {
    "library.upload": {
      run: async (
        call: Call,
        params: MethodParams<"library.upload">,
      ): Promise<MethodResult<"library.upload">> => {
        const now = Date.now();
        await dropStale(now);
        const chunk = Buffer.from(params.bytes, "base64");
        if (chunk.byteLength > UPLOAD_CHUNK_BYTES) {
          throw new PsycheError("invalid_params", "upload chunk is too large");
        }
        const dir = join(libraryRoot(home), "uploads");
        let uploadId = params.uploadId;
        let u: Staged | undefined;
        if (uploadId === undefined) {
          const mine = [...staged.values()].filter((s) => s.deviceId === call.identity.deviceId);
          if (mine.length >= UPLOADS_PER_DEVICE) {
            throw new PsycheError("rate_limited", "too many uploads in progress");
          }
          uploadId = db.newId();
          await mkdir(dir, { recursive: true, mode: 0o700 });
          u = {
            deviceId: call.identity.deviceId,
            name: safeFilename(params.name),
            mime: uploadMime(params.mime, params.name),
            threadId: params.threadId ?? null,
            file: join(dir, `.${uploadId}.part`),
            size: 0,
            touched: now,
          };
          await writeFile(u.file, "", { mode: 0o600 });
          staged.set(uploadId, u);
        } else {
          u = staged.get(uploadId);
          if (u === undefined || u.deviceId !== call.identity.deviceId) {
            throw new PsycheError("not_found", `upload ${uploadId} not found`);
          }
        }
        const upload = u;
        const abandon = async () => {
          staged.delete(uploadId as string);
          await rm(upload.file, { force: true }).catch(() => undefined);
        };
        if (upload.size + chunk.byteLength > UPLOAD_MAX_BYTES) {
          await abandon();
          throw new PsycheError(
            "invalid_params",
            `files over ${UPLOAD_MAX_BYTES / (1024 * 1024)} MiB cannot be attached`,
          );
        }
        try {
          await appendFile(upload.file, chunk);
        } catch (err) {
          await abandon();
          throw fsError(err, upload.name);
        }
        upload.size += chunk.byteLength;
        upload.touched = now;
        if (!params.final) return { uploadId, received: upload.size };
        if (upload.size === 0) {
          await abandon();
          throw new PsycheError("invalid_params", `${upload.name} is empty`);
        }
        const id = db.newId();
        const path = `uploads/${id}-${upload.name}`;
        const stored = join(libraryRoot(home), path);
        try {
          const bytes = await readFile(upload.file);
          await rename(upload.file, stored);
          const item = await indexOrRemove(db, stored, {
            id,
            kind: kindOfMime(upload.mime),
            name: upload.name,
            mime: upload.mime,
            path,
            size: upload.size,
            sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            origin: "upload",
            threadId: upload.threadId,
            tags: [],
            source: null,
          });
          staged.delete(uploadId);
          return { uploadId, received: upload.size, item };
        } catch (err) {
          await abandon();
          throw err;
        }
      },
    },
    "library.list": {
      run: (_call: Call, params: MethodParams<"library.list">): MethodResult<"library.list"> => {
        const offset = decodeOffset(params.cursor);
        const limit = Math.min(params.limit ?? DEFAULT_PAGE, MAX_PAGE);
        const page = listLibraryItemsPage(db, {
          offset,
          limit,
          ...(params.kind === undefined ? {} : { kind: params.kind }),
          ...(params.threadId === undefined ? {} : { threadId: params.threadId }),
          ...(params.taskId === undefined ? {} : { taskId: params.taskId }),
          ...(params.query === undefined ? {} : { query: params.query }),
        });
        return {
          items: page.items,
          nextCursor: page.hasMore ? encodeOffset(offset + page.items.length) : null,
        };
      },
    },
    "library.get": {
      run: (_call: Call, params: MethodParams<"library.get">): MethodResult<"library.get"> => ({
        item: requireItem(db, params.itemId),
      }),
    },
    "library.delete": {
      run: async (
        _call: Call,
        params: MethodParams<"library.delete">,
      ): Promise<MethodResult<"library.delete">> => {
        const item = requireItem(db, params.itemId);
        await removeStored(home, item);
        deleteLibraryItem(db, item.id);
        return { ok: true };
      },
    },
  };
}
