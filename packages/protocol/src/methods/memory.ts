import { Type } from "@sinclair/typebox";
import { Id, IsoDateTime, Nullable, Provenance, StringEnum } from "../common.ts";
import {
  EntitySummary,
  GraphBlocklistEntry,
  GraphEdge,
  GraphEdgeRel,
  GraphEntity,
  GraphEntityDetail,
  GraphEntityKind,
  GraphEntityStatus,
  GraphFact,
  GraphFactAttribute,
  GraphIdentifierKind,
  GraphInteraction,
  GraphLoop,
  GraphLoopStatus,
  GraphProjectStatus,
  GraphRelationshipLabel,
  GraphRemovedCounts,
  GraphSource,
  GraphStatus,
  GraphSuggestion,
  GraphWriteSource,
} from "../schemas/graph.ts";
import {
  MemoryChunk,
  MemoryClaim,
  MemoryFileInfo,
  MemoryHit,
  MemoryJob,
  PersonaIdentity,
} from "../schemas/memory.ts";
import { defineMethod, nextCursor, pageParams } from "./define.ts";

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

  // --- People and projects graph (docs/memory/people-and-projects-2026.md §6.1) ----------------
  "memory.entities.search": defineMethod({
    params: Type.Object({
      q: Type.String({ maxLength: 500, description: "Name, alias, email, phone or keyword" }),
      kinds: Type.Optional(
        Type.Array(GraphEntityKind, { maxItems: 4, description: "Only these entity kinds" }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: "At most this many (default 20)" }),
      ),
    }),
    result: Type.Object({ entities: Type.Array(EntitySummary) }),
    scope: "operator.read",
    description:
      "People, organisations, projects and places ranked by name match, two-way contact recency and frequency.",
  }),
  "memory.entities.get": defineMethod({
    params: Type.Object({ id: Id }),
    result: GraphEntityDetail,
    scope: "operator.read",
    description:
      "One entity with its identifiers, current facts and relations, open loops and last 10 interactions.",
  }),
  "memory.entities.interactions": defineMethod({
    params: Type.Object({ id: Id, ...pageParams }),
    result: Type.Object({ interactions: Type.Array(GraphInteraction), ...nextCursor }),
    scope: "operator.read",
    description: "An entity's interactions, newest first: headers and links, never bodies.",
  }),
  "memory.entities.create": defineMethod({
    params: Type.Object({
      kind: GraphEntityKind,
      name: Type.String({ minLength: 1, maxLength: 200, description: "Display name" }),
      aliases: Type.Optional(
        Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20, description: "Other names" }),
      ),
      identifiers: Type.Optional(
        Type.Array(
          Type.Object({ kind: GraphIdentifierKind, value: Type.String({ maxLength: 512 }) }),
          {
            maxItems: 20,
            description: "Emails, phones, handles; refused if another entity has one",
          },
        ),
      ),
      projectStatus: Type.Optional(GraphProjectStatus),
    }),
    result: Type.Object({ entity: GraphEntity }),
    scope: "operator.write",
    sideEffecting: true,
    description: "The owner creates a person, organisation, project or place. Side-effecting.",
  }),
  "memory.entities.update": defineMethod({
    params: Type.Object({
      id: Id,
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "New name" })),
      aliases: Type.Optional(
        Type.Array(Type.String({ maxLength: 200 }), {
          maxItems: 20,
          description: "Replaces aliases",
        }),
      ),
      status: Type.Optional(GraphEntityStatus),
      projectStatus: Type.Optional(GraphProjectStatus),
      pinned: Type.Optional(Type.Boolean({ description: "Keep at the top and in nightly passes" })),
      hidden: Type.Optional(
        Type.Boolean({ description: "Don't track: block new data about them" }),
      ),
      etag: Type.Optional(Type.String({ maxLength: 128, description: "If-match on the card" })),
    }),
    result: Type.Object({ entity: GraphEntity }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "The owner edits an entity's name, aliases, status, pin or tracking. Side-effecting.",
  }),
  "memory.entities.facts.set": defineMethod({
    params: Type.Object({
      entityId: Id,
      attribute: GraphFactAttribute,
      value: Type.String({ minLength: 1, maxLength: 2000, description: "The owner's value" }),
      source: Type.Optional(GraphWriteSource),
    }),
    result: Type.Object({
      fact: GraphFact,
      /** The previous current fact for this attribute, now superseded (kept in history). */
      superseded: Nullable(Id),
    }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Sets an owner fact; a current value for the attribute is superseded, not deleted. Sensitive traits are refused. Side-effecting.",
  }),
  "memory.entities.facts.retract": defineMethod({
    params: Type.Object({ factId: Id, source: Type.Optional(GraphWriteSource) }),
    result: Type.Object({ fact: GraphFact }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Marks a fact wrong: it is retracted and the same value is never proposed again for that entity. Side-effecting.",
  }),
  "memory.entities.edges.set": defineMethod({
    params: Type.Object({
      src: Id,
      rel: GraphEdgeRel,
      dst: Id,
      label: Type.Optional(GraphRelationshipLabel),
      source: Type.Optional(GraphWriteSource),
    }),
    result: Type.Object({ edge: GraphEdge, superseded: Nullable(Id) }),
    scope: "operator.write",
    sideEffecting: true,
    description: "Sets an owner relation from the allowlist. Side-effecting.",
  }),
  "memory.entities.edges.retract": defineMethod({
    params: Type.Object({ edgeId: Id, source: Type.Optional(GraphWriteSource) }),
    result: Type.Object({ edge: GraphEdge }),
    scope: "operator.write",
    sideEffecting: true,
    description: "Marks a relation wrong; it is retracted and not proposed again. Side-effecting.",
  }),
  "memory.entities.history": defineMethod({
    params: Type.Object({
      entityId: Id,
      attribute: Type.Optional(GraphFactAttribute),
    }),
    result: Type.Object({ facts: Type.Array(GraphFact), edges: Type.Array(GraphEdge) }),
    scope: "operator.read",
    description:
      "Every version of an entity's facts and relations, current and superseded, newest first.",
  }),
  "memory.entities.merge": defineMethod({
    params: Type.Object({
      ids: Type.Array(Id, { minItems: 2, maxItems: 10, description: "Entities to merge" }),
      into: Id,
      dryRun: Type.Optional(Type.Boolean({ description: "Report what would move" })),
    }),
    result: Type.Object({
      entity: GraphEntity,
      movedIdentifiers: Type.Integer({ minimum: 0 }),
      movedFacts: Type.Integer({ minimum: 0 }),
      dryRun: Type.Boolean(),
    }),
    scope: "operator.write",
    sideEffecting: true,
    description: "Merges entities of one kind into `into`; reversible with split. Side-effecting.",
  }),
  "memory.entities.split": defineMethod({
    params: Type.Object({
      id: Id,
      identifiers: Type.Array(
        Type.Object({ kind: GraphIdentifierKind, value: Type.String({ maxLength: 512 }) }),
        { minItems: 1, maxItems: 50, description: "Identifiers that belong to someone else" },
      ),
      name: Type.String({ minLength: 1, maxLength: 200, description: "Name of the new entity" }),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    result: Type.Object({ entity: GraphEntity, dryRun: Type.Boolean() }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Moves identifiers (and their interactions) to a new entity; the pair is never suggested for merging again. Side-effecting.",
  }),
  "memory.entities.suggestions": defineMethod({
    params: Type.Object({
      status: Type.Optional(
        StringEnum(["pending", "later"], {
          $id: "GraphSuggestionFilter",
          description: "Default pending",
        }),
      ),
    }),
    result: Type.Object({ suggestions: Type.Array(GraphSuggestion) }),
    scope: "operator.read",
    description: "Merge and project suggestions waiting for the owner.",
  }),
  "memory.entities.suggestions.answer": defineMethod({
    params: Type.Object({
      id: Id,
      answer: StringEnum(["accept", "reject", "later"], { $id: "GraphSuggestionAnswer" }),
    }),
    result: Type.Object({
      suggestion: GraphSuggestion,
      /** The merged entity or the new project, when accepted. */
      entity: Nullable(GraphEntity),
    }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Answers a suggestion; a rejected merge or project is never suggested again. Side-effecting.",
  }),
  "memory.entities.forget": defineMethod({
    params: Type.Object({
      id: Id,
      dryRun: Type.Optional(Type.Boolean({ description: "Report counts without deleting" })),
    }),
    result: Type.Object({
      removed: Type.Object({
        identifiers: Type.Integer({ minimum: 0 }),
        facts: Type.Integer({ minimum: 0 }),
        edges: Type.Integer({ minimum: 0 }),
        interactions: Type.Integer({ minimum: 0 }),
        loops: Type.Integer({ minimum: 0 }),
      }),
      cardPath: Nullable(Type.String()),
      dryRun: Type.Boolean(),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Deletes an entity and everything about it, and blocklists its identifiers so ingest never recreates it. Side-effecting.",
  }),
  "memory.loops.list": defineMethod({
    params: Type.Object({
      status: Type.Optional(
        Type.Array(GraphLoopStatus, { maxItems: 5, description: "Default suggested and open" }),
      ),
      direction: Type.Optional(
        StringEnum(["i_owe", "waiting_on"], { $id: "GraphLoopDirectionFilter" }),
      ),
      entityId: Type.Optional(Id),
      projectId: Type.Optional(Id),
      dueBefore: Type.Optional(IsoDateTime),
      ...pageParams,
    }),
    result: Type.Object({ loops: Type.Array(GraphLoop), ...nextCursor }),
    scope: "operator.read",
    description:
      "Open loops, oldest first, filtered by status, direction, person, project or due date.",
  }),
  "memory.loops.update": defineMethod({
    params: Type.Object({
      id: Id,
      status: Type.Optional(GraphLoopStatus),
      dueAt: Type.Optional(
        Type.Union([IsoDateTime, Type.Null()], { description: "null clears it" }),
      ),
      text: Type.Optional(
        Type.String({ minLength: 1, maxLength: 200, description: "Rephrase it" }),
      ),
    }),
    result: Type.Object({ loop: GraphLoop }),
    scope: "operator.write",
    sideEffecting: true,
    description:
      "Confirms, completes, snoozes or dismisses a loop, or edits its text or due date. Side-effecting.",
  }),
  "memory.graph.status": defineMethod({
    params: Type.Object({}),
    result: GraphStatus,
    scope: "operator.read",
    description:
      "Graph health: per-source counts and last ingest, last model pass, budget used, loop precision.",
  }),
  "memory.graph.forgetAll": defineMethod({
    params: Type.Object({
      confirm: Type.Literal("forget everything", {
        description: "Must be exactly this phrase; guards against an accidental call",
      }),
      dryRun: Type.Optional(Type.Boolean({ description: "Report counts without deleting" })),
    }),
    result: Type.Object({
      removed: GraphRemovedCounts,
      /** Card files deleted from the workspace. */
      cardPaths: Type.Array(Type.String()),
      dryRun: Type.Boolean(),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Deletes the whole people and projects graph (entities, interactions, facts, loops, suggestions, corrections, blocklist, cursors), every card file and the People / Projects search entries, with secure delete. Turns memory.graph off. Side-effecting.",
  }),
  "memory.graph.deleteSource": defineMethod({
    params: Type.Object({
      source: GraphSource,
      dryRun: Type.Optional(Type.Boolean({ description: "Report counts without deleting" })),
    }),
    result: Type.Object({
      removed: GraphRemovedCounts,
      /** Cards of entities that had nothing else and were deleted. */
      cardPaths: Type.Array(Type.String()),
      dryRun: Type.Boolean(),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Removes everything that came from one source: its interactions, the facts, relations, loops and identifiers derived only from it, and people left with nothing else (their cards and search entries too). The owner's own facts stay. Turns that source off so the next sync does not bring it back. Side-effecting.",
  }),
  "memory.graph.blocklist.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ entries: Type.Array(GraphBlocklistEntry) }),
    scope: "operator.read",
    description: "Identifiers ingest never models again (forgotten people and the owner's blocks).",
  }),
  "memory.graph.blocklist.add": defineMethod({
    params: Type.Object({
      kind: StringEnum(["email", "phone", "domain"], { $id: "GraphBlockKind" }),
      value: Type.String({ minLength: 1, maxLength: 320 }),
    }),
    result: Type.Object({ entry: GraphBlocklistEntry }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Never model this address, phone or domain again (a blocked domain covers every address at it). Existing cards stay until forgotten. Side-effecting.",
  }),
  "memory.graph.blocklist.remove": defineMethod({
    params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) }),
    result: Type.Object({ removed: Type.Boolean() }),
    scope: "operator.admin",
    sideEffecting: true,
    description: "Lets ingest model a blocklisted identifier again. Side-effecting.",
  }),
} as const;
