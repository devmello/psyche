import { type Static, Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, Provenance, StringEnum } from "../common.ts";

/** Data model §7. */
export const MemoryChunk = Type.Object(
  {
    id: Id,
    source: Type.String({ description: 'Workspace path, e.g. "memory/2026-10-18.md"' }),
    lineStart: Type.Integer({ minimum: 1 }),
    lineEnd: Type.Integer({ minimum: 1 }),
    text: Type.String(),
    provenance: Provenance,
    claimId: Nullable(Id),
    tokenCount: Type.Integer({ minimum: 0 }),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { $id: "MemoryChunk" },
);
export type MemoryChunk = Static<typeof MemoryChunk>;

export const MemoryClaim = Type.Object(
  {
    id: Id,
    text: Type.String(),
    kind: StringEnum(["fact", "preference", "relationship", "directive", "event"]),
    provenance: Provenance,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    sources: Type.Array(Type.String()),
    supersededBy: Nullable(Id),
    retractedAt: Nullable(IsoDateTime),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { $id: "MemoryClaim" },
);
export type MemoryClaim = Static<typeof MemoryClaim>;

export const MemoryHit = Type.Object(
  {
    chunk: MemoryChunk,
    score: Type.Number(),
    bm25: Type.Optional(Type.Number()),
    cosine: Type.Optional(Type.Number()),
  },
  { $id: "MemoryHit" },
);
export type MemoryHit = Static<typeof MemoryHit>;
