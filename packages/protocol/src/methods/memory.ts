import { Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Provenance, StringEnum } from "../common.ts";
import {
  MemoryChunk,
  MemoryClaim,
  MemoryFileInfo,
  MemoryHit,
  MemoryJob,
  PersonaIdentity,
} from "../schemas/memory.ts";
import { defineMethod } from "./define.ts";

/** `memory.*` (architecture §4.8; data model §7). Paths are relative to the workspace. */

/** Workspace-relative path: no leading slash, no `..` segment. The Gateway still canonicalizes. */
export const WorkspacePath = Type.String({
  minLength: 1,
  maxLength: 1024,
  pattern: "^(?![/\\\\])(?!.*(^|[/\\\\])\\.\\.([/\\\\]|$)).+$",
  description: 'Workspace-relative path, e.g. "memory/2026-10-18.md"',
  $id: "WorkspacePath",
});

export const MemoryMethods = {
  "memory.search": defineMethod({
    params: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 2000 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      /** Only chunks with one of these provenance classes. */
      provenance: Type.Optional(Type.Array(Provenance, { maxItems: 4 })),
      /** Only chunks whose workspace path starts with one of these prefixes. */
      sources: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 32 })),
    }),
    result: Type.Object({ hits: Type.Array(MemoryHit) }),
    scope: "operator.read",
    description: "Hybrid search (FTS5 + vectors) over memory chunks.",
  }),
  "memory.read": defineMethod({
    params: Type.Object({
      path: WorkspacePath,
      lineStart: Type.Optional(Type.Integer({ minimum: 1 })),
      lineEnd: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    result: Type.Object({
      path: WorkspacePath,
      content: Type.String(),
      updatedAt: IsoDateTime,
      /** Version of the whole file, for `memory.write` `etag` (if-match). */
      etag: Type.Optional(Type.String()),
    }),
    scope: "operator.read",
    description: "Reads a workspace memory file, optionally a line range.",
  }),
  "memory.write": defineMethod({
    params: Type.Object({
      path: WorkspacePath,
      content: Type.String({ maxLength: 1_000_000 }),
      mode: Type.Optional(StringEnum(["replace", "append"], { $id: "MemoryWriteMode" })),
      /** If-match: fails with `conflict` when the file changed since this etag was read. */
      etag: Type.Optional(Type.String({ maxLength: 128 })),
    }),
    result: Type.Object({
      path: WorkspacePath,
      bytes: Type.Integer({ minimum: 0 }),
      updatedAt: IsoDateTime,
      etag: Type.Optional(Type.String()),
    }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Writes a workspace memory file (default replace). Protected files may require an approval. Side-effecting.",
  }),
  "memory.files.list": defineMethod({
    params: Type.Object({ prefix: Type.Optional(Type.String({ maxLength: 1024 })) }),
    result: Type.Object({ files: Type.Array(MemoryFileInfo) }),
    scope: "operator.read",
    description: "Lists workspace files (Soul & Memory sheet), optionally under a path prefix.",
  }),
  "memory.daily.list": defineMethod({
    params: Type.Object({
      /** `YYYY-MM-DD`; only notes strictly before this date (paging backwards). */
      before: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 366 })),
    }),
    result: Type.Object({
      notes: Type.Array(
        Type.Object({
          date: Type.String(),
          path: WorkspacePath,
          entries: Type.Integer({ minimum: 0 }),
          bytes: Type.Integer({ minimum: 0 }),
        }),
      ),
    }),
    scope: "operator.read",
    description: "Daily notes newest first, for the daily-notes browser.",
  }),
  "memory.claims.list": defineMethod({
    params: Type.Object({ includeRetracted: Type.Optional(Type.Boolean()) }),
    result: Type.Object({ claims: Type.Array(MemoryClaim) }),
    scope: "operator.read",
    description: "Lists memory claims (retracted ones only when asked).",
  }),
  "memory.claims.confirm": defineMethod({
    params: Type.Object({ claimId: Id }),
    result: Type.Object({ claim: MemoryClaim }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "The owner confirms an agent or imported claim; it becomes an owner claim that supersedes it. Claims derived from untrusted sources are refused. Side-effecting.",
  }),
  "memory.explain": defineMethod({
    params: Type.Object({ claimId: Id }),
    result: Type.Object({ claim: MemoryClaim, chunks: Type.Array(MemoryChunk) }),
    scope: "operator.read",
    description: "Why a fact is believed: the claim with its source chunks and provenance.",
  }),
  "memory.forget": defineMethod({
    params: Type.Object({
      subject: Type.String({ minLength: 1, maxLength: 500 }),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    result: Type.Object({
      retractedClaimIds: Type.Array(Id),
      removedChunkIds: Type.Array(Id),
      /** Workspace files whose lines were removed (or would be, on a dry run). */
      files: Type.Array(WorkspacePath),
    }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Retracts matching claims, removes linked daily-note lines and chunks and rebuilds the index; dryRun reports without changing. Side-effecting.",
  }),
  "memory.forgetLearned": defineMethod({
    params: Type.Object({ factId: Type.String({ pattern: "^lf_[a-z0-9]{6,32}$" }) }),
    result: Type.Object({ removed: Type.Boolean() }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Undo for a learned fact (#509): removes its line from USER.md's Learned section (removed false when it is already gone). Side-effecting.",
  }),
  "memory.remember": defineMethod({
    params: Type.Object({ text: Type.String({ minLength: 1, maxLength: 4000 }) }),
    result: Type.Object({ path: WorkspacePath, chunk: MemoryChunk }),
    scope: "operator.write",
    sideEffecting: true,
    description: "Appends an owner-provenance entry to today's daily note. Side-effecting.",
  }),
  "memory.import": defineMethod({
    params: Type.Object({
      format: StringEnum(["chatgpt", "claude", "text", "openclaw"], { $id: "MemoryImportFormat" }),
      /** Export text (JSON or Markdown) for chatgpt / claude / text. */
      content: Type.Optional(Type.String({ maxLength: 2_000_000 })),
      /** Workspace files for openclaw, read by the client from the chosen folder. */
      files: Type.Optional(
        Type.Array(
          Type.Object({ path: WorkspacePath, content: Type.String({ maxLength: 1_000_000 }) }),
          { maxItems: 2000 },
        ),
      ),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    result: Type.Object({
      /** Staged claims (agent provenance) awaiting item-by-item confirmation. */
      claims: Type.Array(MemoryClaim),
      /** Claim ids whose text looked like an instruction (flagged for review). */
      flagged: Type.Array(Id),
      /** Workspace files written (openclaw) or that would be written (dry run). */
      files: Type.Array(WorkspacePath),
      skipped: Type.Integer({ minimum: 0 }),
    }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Imports memory from another assistant as data: parsed into agent-provenance claims, scanned and size-capped (security §8). Side-effecting.",
  }),
  "memory.export": defineMethod({
    params: Type.Object({}),
    result: Type.Object({
      filename: Type.String(),
      mime: Type.Literal("application/zip"),
      /** Base64 zip of the workspace plus `claims.json`. */
      data: Type.String(),
      bytes: Type.Integer({ minimum: 0 }),
    }),
    scope: "operator.read",
    description: "Exports the whole workspace and the claims as a zip.",
  }),
  "memory.reset": defineMethod({
    params: Type.Object({
      dryRun: Type.Optional(Type.Boolean()),
      /** Fresh presence: the approved `policy_change` card from a first `approval_required` call. */
      approvalId: Type.Optional(Id),
    }),
    result: Type.Object({
      files: Type.Array(WorkspacePath),
      chunks: Type.Integer({ minimum: 0 }),
      claims: Type.Integer({ minimum: 0 }),
      dryRun: Type.Boolean(),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Deletes every workspace file, chunk and claim and re-creates the templates; the UI asks for a typed confirmation first. Side-effecting.",
  }),
  "memory.status": defineMethod({
    params: Type.Object({}),
    result: Type.Object({
      paused: Type.Boolean(),
      vectorSearch: StringEnum(["sqlite-vec", "brute-force", "off"], { $id: "MemoryVectorMode" }),
      files: Type.Integer({ minimum: 0 }),
      chunks: Type.Integer({ minimum: 0 }),
      claims: Type.Integer({ minimum: 0 }),
      lastJobs: Type.Array(MemoryJob),
    }),
    scope: "operator.read",
    description: "Memory health for the Soul & Memory sheet: pause flag, index mode, counts, jobs.",
  }),
  "memory.pause": defineMethod({
    params: Type.Object({ paused: Type.Boolean() }),
    result: Type.Object({ paused: Type.Boolean() }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Pauses or resumes memory: while paused nothing is flushed, remembered or indexed from chats. Side-effecting.",
  }),
  "memory.persona.get": defineMethod({
    params: Type.Object({}),
    result: Type.Object({
      identity: PersonaIdentity,
      /** The free-form self-description after the frontmatter. */
      description: Type.String(),
      etag: Type.String(),
    }),
    scope: "operator.read",
    description:
      "The persona from IDENTITY.md (name, creature, vibe, tagline, emoji, avatar, voice).",
  }),
  "memory.persona.edit": defineMethod({
    params: Type.Object({
      /** A natural-language change ("make yourself a pink hippo named Flash"), feature H9. */
      instruction: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
      /** Or explicit field values; applied after the instruction's changes. */
      fields: Type.Optional(Type.Partial(PersonaIdentity)),
      description: Type.Optional(Type.String({ maxLength: 2000 })),
      /** If-match on IDENTITY.md. */
      etag: Type.Optional(Type.String({ maxLength: 128 })),
    }),
    result: Type.Object({
      identity: PersonaIdentity,
      description: Type.String(),
      etag: Type.String(),
      /** Fields that changed. */
      changed: Type.Array(Type.String()),
      /** True when the change calls for a new avatar (see `persona.updated`). */
      avatarRequested: Type.Boolean(),
    }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "The owner edits the persona in words or fields; IDENTITY.md is rewritten and persona.updated is emitted. Side-effecting.",
  }),
} as const;
