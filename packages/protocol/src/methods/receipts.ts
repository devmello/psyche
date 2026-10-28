import { Type } from "@sinclair/typebox";
import { Id } from "../common.ts";
import {
  ArtifactConflict,
  ArtifactOp,
  ArtifactRef,
  ArtifactTableView,
  ArtifactVersion,
} from "../schemas/artifacts.ts";
import { Receipt } from "../schemas/permissions.ts";
import { Artifact, ArtifactType } from "../schemas/surfaces.ts";
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
  "artifacts.export": defineMethod({
    params: Type.Object({
      artifactId: Id,
      /** `md`, `docx`, `pdf` (doc); `xlsx`, `csv` (workbook); `pptx`, `pdf` (slides). */
      format: Type.String({ minLength: 2, maxLength: 8 }),
      version: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    result: Type.Object(
      {
        name: Type.String(),
        mime: Type.String(),
        /** The file, base64. */
        data: Type.String(),
      },
      { $id: "ArtifactExport" },
    ),
    scope: "operator.read",
    sideEffecting: false,
    description:
      "Renders a doc, workbook or deck as a file (docx, xlsx, pptx, pdf, md, csv) for download. Nothing is written to the owner's disk.",
  }),
} as const;

const ArtifactWritten = Type.Object({
  artifact: Artifact,
  /** The new version, or the latest one when `conflict` is set. */
  ref: ArtifactRef,
  /** Set when `base` was not the latest version: nothing was written (§4.4). */
  conflict: Type.Optional(ArtifactConflict),
});

/**
 * `artifacts.*` (docs/design/chat-experience-2026.md §4.3, §4.4): canvas artifacts with a version
 * store. The agent reaches the same operations through its `artifact.*` tools; a call over the
 * wire is the user editing in the canvas, so its versions are authored by `user`.
 */
export const ArtifactsMethods = {
  "artifacts.get": defineMethod({
    params: Type.Object({ artifactId: Id }),
    result: Type.Object({ artifact: Artifact }),
    scope: "operator.read",
    description: "Returns one artifact's metadata (content through `artifacts.read`).",
  }),
  "artifacts.list": defineMethod({
    params: Type.Object({ threadId: Type.Optional(Id), ...pageParams }),
    result: Type.Object({ artifacts: Type.Array(Artifact), ...nextCursor }),
    scope: "operator.read",
    description: "Lists canvas artifacts, most recently updated first, optionally for one thread.",
  }),
  "artifacts.read": defineMethod({
    params: Type.Object({
      artifactId: Id,
      /** The latest when omitted. */
      version: Type.Optional(Type.Integer({ minimum: 1 })),
      /** One-based inclusive line window for text types. */
      lines: Type.Optional(
        Type.Object({
          from: Type.Integer({ minimum: 1 }),
          to: Type.Integer({ minimum: 1 }),
        }),
      ),
    }),
    result: Type.Object({
      artifactId: Id,
      version: Type.Integer({ minimum: 1 }),
      type: ArtifactType,
      /** Text for `doc`/`code`, `ArtifactTable` JSON for `table`, a Library path for `image`. */
      content: Type.String(),
      totalLines: Type.Integer({ minimum: 0 }),
      /** Table view metadata (sort, filter) at this version. */
      view: Type.Optional(ArtifactTableView),
    }),
    scope: "operator.read",
    description: "Returns an artifact's content at a version, or a window of its lines.",
  }),
  "artifacts.versions": defineMethod({
    params: Type.Object({ artifactId: Id }),
    result: Type.Object({ versions: Type.Array(ArtifactVersion) }),
    scope: "operator.read",
    description: "Lists every version of an artifact, oldest first (history is never deleted).",
  }),
  "artifacts.create": defineMethod({
    params: Type.Object({
      type: ArtifactType,
      title: Type.String({ minLength: 1, maxLength: 200 }),
      content: Type.String({ maxLength: 2_000_000 }),
      language: Type.Optional(Type.String({ maxLength: 40 })),
      threadId: Type.Optional(Id),
    }),
    result: ArtifactWritten,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Creates a canvas artifact at version 1 (doc, code, table or image). Side-effecting: a retried key returns the same artifact.",
  }),
  "artifacts.update": defineMethod({
    params: Type.Object({
      artifactId: Id,
      /** The version the ops apply to; a stale base returns `conflict` and writes nothing. */
      base: Type.Integer({ minimum: 1 }),
      ops: Type.Array(ArtifactOp, { minItems: 1, maxItems: 200 }),
    }),
    result: ArtifactWritten,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Applies edit ops to an artifact as a new version; `replace` and `insert` anchors must match exactly once. Side-effecting.",
  }),
  "artifacts.restore": defineMethod({
    params: Type.Object({ artifactId: Id, version: Type.Integer({ minimum: 1 }) }),
    result: ArtifactWritten,
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Restores an old version as a new latest version (nothing is deleted). Side-effecting.",
  }),
} as const;
