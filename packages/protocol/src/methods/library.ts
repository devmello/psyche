import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { LibraryItem, LibraryItemKind } from "../schemas/surfaces.ts";
import { defineMethod, nextCursor, OkResult, pageParams } from "./define.ts";

/** `library.*` (data model §9). */

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
  "library.delete": defineMethod({
    params: Type.Object({ itemId: Id }),
    result: OkResult,
    scope: "operator.write",
    description: "Deletes a Library item and its file.",
  }),
} as const;
