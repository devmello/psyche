import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import { Receipt } from "../schemas/permissions.ts";
import { Artifact } from "../schemas/surfaces.ts";
import { defineMethod, nextCursor, pageParams } from "./define.ts";

/** `receipts.*` and `artifacts.*`: read-only lookups for receipt and artifact blocks (data model §5, §9). */

export const ReceiptsMethods = {
  "receipts.get": defineMethod({
    params: Type.Object({ receiptId: Id }),
    result: Type.Object({ receipt: Receipt }),
    scope: "operator.read",
    description: "Returns one receipt (the receipt line under an external write).",
  }),
  "receipts.list": defineMethod({
    params: Type.Object({ taskId: Type.Optional(Id), ...pageParams }),
    result: Type.Object({ receipts: Type.Array(Receipt), ...nextCursor }),
    scope: "operator.read",
    description: "Lists receipts, newest first, optionally for one task.",
  }),
} as const;

export const ArtifactsMethods = {
  "artifacts.get": defineMethod({
    params: Type.Object({ artifactId: Id }),
    result: Type.Object({ artifact: Artifact }),
    scope: "operator.read",
    description: "Returns one artifact's metadata (content is fetched over HTTP).",
  }),
} as const;
