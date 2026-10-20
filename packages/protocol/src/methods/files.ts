import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTime, Nullable, StringEnum } from "../common.ts";
import { defineMethod } from "./define.ts";

/**
 * `files.*` and `documents.convert`: read-only access for the Files pane and its viewers (UI
 * design §3.7, feature P4). A file is named either by an absolute `path` in a folder the owner
 * granted (`permissions.policy.folders`, through no symlink) or by a `libraryPath` relative to
 * `$PSYCHE_HOME/library` (a `LibraryItem.path`); exactly one of the two. Bytes come in base64
 * chunks so every frame stays under `MAX_FRAME_BYTES`; page with `offset` / `nextOffset`.
 */

/** Bytes one `files.read` or `documents.convert` call returns (about 683 KiB as base64). */
export const FILE_CHUNK_BYTES = 512 * 1024;

/** Entries one `files.list` call returns. */
export const FILE_LIST_PAGE = 500;

export const FileSourcePath = Type.String({
  minLength: 2,
  maxLength: 4096,
  pattern: "^/",
  description: "an absolute path in a granted folder",
});

export const LibraryRelativePath = Type.String({
  minLength: 1,
  maxLength: 4096,
  pattern: "^[^/]",
  description: "a path relative to the Library (LibraryItem.path)",
});

/** Names one file: `path` or `libraryPath`, never both. */
const fileSource = {
  path: Type.Optional(FileSourcePath),
  libraryPath: Type.Optional(LibraryRelativePath),
};

const chunkParams = {
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "byte offset; default 0" })),
  length: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: FILE_CHUNK_BYTES,
      description: `bytes to return; default and maximum ${FILE_CHUNK_BYTES}`,
    }),
  ),
};

const chunkResult = {
  size: Type.Integer({ minimum: 0, description: "the whole content's size in bytes" }),
  offset: Type.Integer({ minimum: 0 }),
  bytes: Type.String({ contentEncoding: "base64", description: "this chunk, base64" }),
  nextOffset: Nullable(Type.Integer({ minimum: 0 })),
};

export const FileEntryKind = StringEnum(["file", "folder", "other"], { $id: "FileEntryKind" });
export type FileEntryKind = Static<typeof FileEntryKind>;

export const FileEntry = Type.Object(
  {
    name: Type.String(),
    /** Absolute; pass it back to `files.list` or `files.read`. */
    path: Type.String(),
    kind: FileEntryKind,
    /** Files only. */
    size: Nullable(Type.Integer({ minimum: 0 })),
    modifiedAt: Nullable(IsoDateTime),
  },
  { $id: "FileEntry" },
);
export type FileEntry = Static<typeof FileEntry>;

export const ConversionTarget = StringEnum(["pdf", "thumbnail"], { $id: "ConversionTarget" });
export type ConversionTarget = Static<typeof ConversionTarget>;

export const FilesMethods = {
  "files.list": defineMethod({
    params: Type.Object({
      path: FileSourcePath,
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    result: Type.Object({
      entries: Type.Array(FileEntry, { maxItems: FILE_LIST_PAGE }),
      nextOffset: Nullable(Type.Integer({ minimum: 0 })),
    }),
    scope: "operator.read",
    description: `Lists a folder inside a granted folder, folders first then by name, ${FILE_LIST_PAGE} entries per page. Symlinks are listed as \`other\`. forbidden outside every granted folder or through a symlink; not_found when missing.`,
  }),
  "files.read": defineMethod({
    params: Type.Object({ ...fileSource, ...chunkParams }),
    result: Type.Object({
      name: Type.String(),
      mime: Type.String({ description: "from the extension; application/octet-stream if unknown" }),
      modifiedAt: IsoDateTime,
      /** Changes when the file does; a reader restarts if it changes between chunks. */
      etag: Type.String(),
      ...chunkResult,
    }),
    scope: "operator.read",
    description:
      "Reads a chunk of a file in a granted folder or the Library. invalid_params unless exactly one of path / libraryPath; forbidden outside them or through a symlink; not_found when missing.",
  }),
  "documents.convert": defineMethod({
    params: Type.Object({ ...fileSource, target: ConversionTarget, ...chunkParams }),
    result: Type.Object({
      mime: StringEnum(["application/pdf", "image/png"]),
      ...chunkResult,
    }),
    scope: "operator.read",
    description:
      "Converts an Office file (slides, documents, sheets) to PDF or a PNG thumbnail with LibreOffice in the sandbox, cached by the file's etag, and returns a chunk of the result; call again with nextOffset for the rest. unavailable with details.reason `sandbox_unavailable` (no container runtime) or `image_missing` (the full sandbox image with LibreOffice is not installed); invalid_params for a file it cannot convert.",
  }),
} as const;
