import { type Static, Type } from "@sinclair/typebox";
import { ABSOLUTE_HOST_PATH_PATTERN, Id, IsoDateTime, Nullable, StringEnum } from "../common.ts";
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
  pattern: ABSOLUTE_HOST_PATH_PATTERN,
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

/**
 * The most text one `files.write` call saves (UTF-8 bytes). One frame is at most 1 MiB, JSON
 * escaping can double the text, and a frame over the limit closes the socket: stay well under.
 */
export const FILE_WRITE_MAX_BYTES = 512 * 1024;

/** The largest JSON-encoded `files.write` request a client may send (bytes). */
export const FILE_WRITE_MAX_REQUEST_BYTES = 900 * 1000;

/** The extensions `files.write` saves; the Files pane edits only these (Markdown, text, CSV). */
export const FILE_WRITE_EXTENSIONS = [".md", ".markdown", ".txt", ".csv"] as const;

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

export const StarterFolderId = StringEnum(["documents", "desktop", "downloads"], {
  $id: "StarterFolderId",
});
export type StarterFolderId = Static<typeof StarterFolderId>;

export const FilesMethods = {
  "files.starterFolders": defineMethod({
    params: Type.Object({}),
    result: Type.Object({
      folders: Type.Array(
        Type.Object({ id: StarterFolderId, path: Type.String({ maxLength: 4096 }) }),
        { maxItems: 3 },
      ),
    }),
    scope: "operator.read",
    description:
      "The folders onboarding may offer to share read-only (Documents, Desktop, Downloads under the owner's home): only those that exist, are not sensitive roots (`assertFolderGrantable`) and are not already covered by a granted folder. Grants through `settings.set` of `permissions.policy`, never from here.",
  }),
  "files.requestShare": defineMethod({
    params: Type.Object({
      threadId: Id,
      path: Type.String({
        minLength: 1,
        maxLength: 1024,
        description:
          "The folder the failed file tool named: a hint for the picker, never what is granted",
      }),
      access: Type.Literal("read"),
    }),
    result: Type.Object({
      status: StringEnum(["pending", "already"]),
      approvalId: Type.Optional(Id),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "The \"Share this folder (read only)\" button on a file tool's outside-every-granted-folder error: raises the same `folder_access` approval card `request_folder_access` raises (same binding, native picker, Allow once / Always; a tainted thread is offered Allow once only) outside an agent run. `path` only pre-fills the card: the owner's pick is what is granted, and nothing is granted without the card. Read only: any other `access` is invalid_params. `pending` carries the card's `approvalId`; `already` when a granted folder covers the path. forbidden for a device without operator.admin; not_found for an unknown thread. Side-effecting.",
  }),
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
  "files.write": defineMethod({
    params: Type.Object({
      path: FileSourcePath,
      content: Type.String({ description: "UTF-8 text" }),
      ifMatch: Type.String({
        description: "the etag `files.read` returned; the file must still match",
      }),
    }),
    result: Type.Object({
      etag: Type.String(),
      modifiedAt: IsoDateTime,
      size: Type.Integer({ minimum: 0 }),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description: `The owner's own edit of an existing text file from the Files pane. Only a paired device with operator.admin can call it; no tool, agent, MCP server or channel reaches it, and it raises no approval card (the agent's write_file asks unless Auto mode or a grant allows it). The path must lie in a folder shared read & write (permissions.policy.folders, mode rw; a single attached file or a read-only folder never qualifies), go through no symlink, stay out of Psyche's home and the credential stores, and end in ${FILE_WRITE_EXTENSIONS.join(", ")}. The file must exist, have one name and be writable by its owner. Content is UTF-8, at most ${FILE_WRITE_MAX_BYTES} bytes (invalid_params above that) so the request fits one frame. ifMatch must equal the file's current etag or the call fails with conflict. The write is atomic (temp file, then rename) and keeps the permission bits (setuid and setgid are dropped). Audited as files.write with the path and byte count, never the content. forbidden, not_found, invalid_params, conflict. Side-effecting.`,
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
