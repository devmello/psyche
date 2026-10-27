import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SniffResult } from "./sniff.ts";

/**
 * Where quarantined downloads go (feature I9; architecture §12 `library/quarantine/`). No
 * protocol contract exists for the Library yet, so this package defines the narrow writer it
 * needs; the Library owner implements it (request in docs/archive/status/s08.md). Files are never
 * opened or executed here.
 */
export interface QuarantinedFile {
  /** Absolute path of the file as it landed (desktop quarantine or Playwright save path). */
  path: string;
  filename: string;
  declaredMime: string | null;
  sourceUrl: string;
  taskId?: string;
}

export interface LibraryImport {
  libraryItemId: string;
  mime: string;
  size: number;
  sha256: string;
  executable: boolean;
  mismatch: boolean;
}

export interface RecordingImport {
  /** The recording id (task id or `thread:<id>`). */
  id: string;
  /** Absolute directory holding frames, snapshots and `index.json`. */
  dir: string;
  taskId: string | null;
  threadId: string | null;
  frameCount: number;
  eventCount: number;
}

export interface LibraryWriter {
  /** Move a quarantined download into the Library as `kind: download`, still quarantined. */
  importDownload(file: QuarantinedFile, sniffed: SniffResult): Promise<LibraryImport>;
  /** Register a finished recording as `kind: recording` (feature I10); files stay in place. */
  importRecording?(recording: RecordingImport): Promise<{ libraryItemId: string }>;
}

/** Strip path separators, control characters and leading dots from a server-chosen name. */
export function safeFilename(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
  const base = basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f/:]/g, "_");
  const trimmed = base.replace(/^\.+/, "").slice(0, 200);
  return trimmed === "" ? "download" : trimmed;
}

/** Read up to `n` bytes from the start of a file, and hash the whole file. */
export async function headAndHash(
  path: string,
  n = 4096,
): Promise<{ head: Uint8Array; sha256: string; size: number }> {
  const fh = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const head = new Uint8Array(n);
    let headLen = 0;
    let size = 0;
    const buf = new Uint8Array(65_536);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, size);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      if (headLen < n) {
        const take = Math.min(n - headLen, bytesRead);
        head.set(chunk.subarray(0, take), headLen);
        headLen += take;
      }
      hash.update(chunk);
      size += bytesRead;
    }
    return { head: head.subarray(0, headLen), sha256: `sha256:${hash.digest("hex")}`, size };
  } finally {
    await fh.close();
  }
}

/**
 * File-system writer: moves files into `<libraryDir>/quarantine/<id>-<name>` and keeps an
 * in-memory index. The real Library (S13/S04) replaces it with a `library_items` row.
 */
export class FsQuarantineWriter implements LibraryWriter {
  readonly items = new Map<string, LibraryImport & QuarantinedFile & { storedPath: string }>();
  /** Recordings by recording id → Library item id (in memory until the Library owner ships). */
  readonly recordings = new Map<string, RecordingImport & { libraryItemId: string }>();
  #dir: string;

  constructor(libraryDir: string) {
    this.#dir = join(libraryDir, "quarantine");
  }

  async importDownload(file: QuarantinedFile, sniffed: SniffResult): Promise<LibraryImport> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const storedPath = join(this.#dir, `${id}-${safeFilename(file.filename)}`);
    try {
      await rename(file.path, storedPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await copyFile(file.path, storedPath);
      await rm(file.path, { force: true });
    }
    const { sha256, size } = await headAndHash(storedPath);
    const s = await stat(storedPath);
    const item: LibraryImport = {
      libraryItemId: id,
      mime: sniffed.mime,
      size: s.size || size,
      sha256,
      executable: sniffed.executable,
      mismatch: sniffed.mismatch,
    };
    this.items.set(id, { ...item, ...file, storedPath });
    return item;
  }

  async importRecording(recording: RecordingImport): Promise<{ libraryItemId: string }> {
    const existing = this.recordings.get(recording.id);
    const libraryItemId = existing?.libraryItemId ?? randomUUID();
    this.recordings.set(recording.id, { ...recording, libraryItemId });
    return { libraryItemId };
  }
}
