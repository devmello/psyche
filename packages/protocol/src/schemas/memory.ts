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

/** One workspace file as listed by the Soul & Memory sheet (architecture §4.8). */
export const MemoryFileInfo = Type.Object(
  {
    path: Type.String({ description: 'Workspace path, e.g. "SOUL.md"' }),
    bytes: Type.Integer({ minimum: 0 }),
    etag: Type.String(),
    /** Writes by the agent need a `memory_protected_write` approval (security §8). */
    protected: Type.Boolean(),
    /** Least-trusted provenance of the content last written (owner for external edits). */
    provenance: Provenance,
    updatedAt: IsoDateTime,
  },
  { $id: "MemoryFileInfo" },
);
export type MemoryFileInfo = Static<typeof MemoryFileInfo>;

/** Data model §7 `memory_jobs`. */
export const MemoryJobKind = StringEnum(["flush", "dreaming", "reindex", "import"], {
  $id: "MemoryJobKind",
});
export type MemoryJobKind = Static<typeof MemoryJobKind>;

export const MemoryJob = Type.Object(
  {
    id: Id,
    kind: MemoryJobKind,
    status: StringEnum(["running", "ok", "failed", "skipped"], { $id: "MemoryJobStatus" }),
    startedAt: IsoDateTime,
    endedAt: Nullable(IsoDateTime),
    /** Counts and outcome in plain words; never the remembered content. */
    summary: Nullable(Type.String()),
  },
  { $id: "MemoryJob" },
);
export type MemoryJob = Static<typeof MemoryJob>;

/** Who changed a workspace file: a tool call, the API, an edit outside Psyche, or a job. */
export const MemoryChangeSource = StringEnum(["tool", "api", "external", "job"], {
  $id: "MemoryChangeSource",
});
export type MemoryChangeSource = Static<typeof MemoryChangeSource>;

/** `IDENTITY.md` frontmatter (data model §7.1); every field optional, unknown keys are kept. */
export const PersonaIdentity = Type.Object(
  {
    name: Type.Optional(Type.String({ maxLength: 80 })),
    creature: Type.Optional(Type.String({ maxLength: 300 })),
    vibe: Type.Optional(Type.String({ maxLength: 200 })),
    tagline: Type.Optional(Type.String({ maxLength: 200 })),
    emoji: Type.Optional(Type.String({ maxLength: 16 })),
    avatar: Type.Optional(Type.String({ maxLength: 200, description: "Asset id of the avatar" })),
    voice: Type.Optional(Type.String({ maxLength: 120 })),
  },
  { $id: "PersonaIdentity" },
);
export type PersonaIdentity = Static<typeof PersonaIdentity>;
