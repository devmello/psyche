import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { LibraryItem, LibraryItemKind } from "../schemas/surfaces.ts";
import { defineMethod, nextCursor, OkResult, pageParams } from "./define.ts";

/** `library.*` (data model §9). */

/** Raw bytes one `library.upload` call carries (512 KiB as base64, well under `MAX_FRAME_BYTES`). */
export const UPLOAD_CHUNK_BYTES = 384 * 1024;

/** Largest file `library.upload` accepts. */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export const LibraryMethods = {
  "library.list": defineMethod({
    params: Type.Object({
      kind: Type.Optional(LibraryItemKind),
      threadId: Type.Optional(Id),
      taskId: Type.Optional(Id),
      query: Type.Optional(Type.String({ maxLength: 500 })),
      ...pageParams,
    }),
    result: Type.Object({ items: Type.Array(LibraryItem), ...nextCursor }),
    scope: "operator.read",
    description: "Lists Library items, newest first.",
  }),
  "library.get": defineMethod({
    params: Type.Object({ itemId: Id }),
    result: Type.Object({ item: LibraryItem }),
    scope: "operator.read",
    description: "Returns one Library item's metadata (content is fetched over HTTP).",
  }),
  "library.upload": defineMethod({
    params: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 255, description: "the file's name" }),
      mime: Type.Optional(Type.String({ maxLength: 255 })),
      /** The upload a later chunk continues; absent on the first chunk. */
      uploadId: Type.Optional(Id),
      /** The chunk, base64; at most `UPLOAD_CHUNK_BYTES` raw. */
      bytes: Type.String({ contentEncoding: "base64", maxLength: 600 * 1024 }),
      /** The last chunk: the Gateway stores the file and returns its item. */
      final: Type.Boolean(),
      threadId: Type.Optional(Id),
    }),
    result: Type.Object(
      {
        uploadId: Id,
        received: Type.Integer({ minimum: 0 }),
        item: Type.Optional(LibraryItem),
      },
      { $id: "LibraryUploadResult" },
    ),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Uploads a file into the Library in base64 chunks (the first chunk omits uploadId; the last sets final and returns the item, origin upload, not quarantined: the owner chose it). invalid_params for a file over 25 MiB or an empty one. Attach the item's id to chat.send. Side-effecting.",
  }),
  "library.delete": defineMethod({
    params: Type.Object({ itemId: Id }),
    result: OkResult,
    scope: "operator.write",
    description: "Deletes a Library item and its file.",
  }),
} as const;
