import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { safeFilename } from "@psyche/browser";
import { insertLibraryItem, type PsycheDb } from "@psyche/db";
import {
  assertGranted,
  assertNoSymlinks,
  assertNotProtected,
  canonicalTarget,
  fsError,
  type GrantedFolder,
} from "@psyche/files";
import type { FolderFile } from "@psyche/proactive";
import { PsycheError } from "@psyche/protocol";
import { openRegularFile, resolveFileSource } from "./files.ts";
import { kindOfMime, libraryRoot } from "./library.ts";
import { protectedRoots } from "./protected-paths.ts";

/**
 * The recordings-folder watch's file access (#953). The folder is read only through the
 * owner's folder grants (read access, `files.read`'s rules: protected roots refused, no
 * symlinks), at its top level. A new recording is copied into the Library as an ordinary
 * `upload` item (`uploads/<id>-<name>`), the layout `meetings.notes.create` reads; the file in
 * the owner's folder is never changed.
 */

const AUDIO_MIME: Record<string, string> = {
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".caf": "audio/x-caf",
};

export interface RecordingsFolderSetup {
  db: PsycheDb;
  /** `$PSYCHE_HOME`; the Library is its `library/` folder. */
  home: string;
  /** The granted folders, read on every call so a revoked grant applies at once. */
  folders: () => readonly GrantedFolder[];
}

export interface RecordingsFolderIo {
  granted(folder: string): boolean;
  list(folder: string): Promise<FolderFile[]>;
  copy(file: FolderFile): Promise<{ libraryItemId: string }>;
}

export function recordingsFolderIo(setup: RecordingsFolderSetup): RecordingsFolderIo {
  const { db, home } = setup;
  return {
    granted(folder) {
      try {
        const dir = canonicalTarget(folder);
        assertNotProtected(dir, protectedRoots(home));
        assertGranted(dir, setup.folders(), "read");
        return true;
      } catch {
        return false;
      }
    },

    async list(folder) {
      const dir = canonicalTarget(folder);
      assertNotProtected(dir, protectedRoots(home));
      assertGranted(dir, setup.folders(), "read");
      await assertNoSymlinks(dir);
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        throw fsError(err, dir);
      }
      const out: FolderFile[] = [];
      for (const d of entries) {
        // A symlink is neither a file nor a folder here: it is skipped, never followed.
        if (!d.isFile()) continue;
        const path = join(dir, d.name);
        try {
          const info = await lstat(path);
          if (info.isFile())
            out.push({ name: d.name, path, size: info.size, mtimeMs: info.mtimeMs });
        } catch {
          // Gone since readdir.
        }
      }
      return out;
    },

    async copy(file) {
      const source = await resolveFileSource({ path: file.path }, { folders: setup.folders, home });
      const mime = AUDIO_MIME[extname(source.name).toLowerCase()];
      if (mime === undefined) throw new PsycheError("invalid_params", "not an audio recording");
      const id = db.newId();
      const name = safeFilename(source.name);
      const path = `uploads/${id}-${name}`;
      const dir = join(libraryRoot(home), "uploads");
      const stored = join(libraryRoot(home), path);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const fh = await openRegularFile(source.path);
      try {
        const hash = createHash("sha256");
        let size = 0;
        const input = fh.createReadStream();
        input.on("data", (chunk: string | Buffer) => {
          hash.update(chunk);
          size += chunk.length;
        });
        try {
          await pipeline(input, createWriteStream(stored, { mode: 0o600, flags: "wx" }));
          if (size === 0) throw new PsycheError("invalid_params", `${name} is empty`);
          const item = insertLibraryItem(db, {
            id,
            kind: kindOfMime(mime),
            name,
            mime,
            path,
            size,
            sha256: `sha256:${hash.digest("hex")}`,
            origin: "upload",
            tags: ["recordings-folder"],
            source: { recordingsFolder: true },
          });
          return { libraryItemId: item.id };
        } catch (err) {
          await rm(stored, { force: true }).catch(() => undefined);
          throw err;
        }
      } finally {
        await fh.close().catch(() => undefined);
      }
    },
  };
}
