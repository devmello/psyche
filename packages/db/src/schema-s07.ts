/**
 * drizzle mirror of the memory tables (owner S07, `packages/memory`); see the header of
 * `schema.ts` for the conventions.
 */
import { blob, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// §7 Memory (owner S07; migrations/202610191230_memory_index.sql). `memory_fts` (FTS5) and
// `memory_vec` (sqlite-vec, created at run time) are virtual tables and are not mirrored.

export const memoryFiles = sqliteTable("memory_files", {
  path: text("path").primaryKey(),
  sha256: text("sha256").notNull(),
  bytes: integer("bytes").notNull(),
  provenance: text("provenance").notNull(),
  mtimeMs: integer("mtime_ms"),
  indexedAt: text("indexed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const memoryClaims = sqliteTable("memory_claims", {
  id: text("id").primaryKey(),
  text: text("text").notNull(),
  kind: text("kind").notNull(),
  provenance: text("provenance").notNull(),
  confidence: real("confidence").notNull(),
  sources: text("sources").notNull(),
  supersededBy: text("superseded_by"),
  retractedAt: text("retracted_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const memoryChunks = sqliteTable("memory_chunks", {
  rowid: integer("rowid").primaryKey(),
  id: text("id").notNull().unique(),
  source: text("source").notNull(),
  lineStart: integer("line_start").notNull(),
  lineEnd: integer("line_end").notNull(),
  text: text("text").notNull(),
  provenance: text("provenance").notNull(),
  claimId: text("claim_id"),
  tokenCount: integer("token_count").notNull(),
  embedding: blob("embedding", { mode: "buffer" }),
  embeddingModel: text("embedding_model"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const memoryJobs = sqliteTable("memory_jobs", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  summary: text("summary"),
  createdAt: text("created_at").notNull(),
});

export const memoryState = sqliteTable("memory_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const memoryRecalls = sqliteTable("memory_recalls", {
  id: integer("id").primaryKey(),
  chunkId: text("chunk_id").notNull(),
  queryHash: text("query_hash").notNull(),
  createdAt: text("created_at").notNull(),
});

// People and projects graph (migrations/202610251200_memory_graph.sql). `graph_fts` (FTS5) is a
// virtual table and is not mirrored.

export const graphEntities = sqliteTable("graph_entities", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  sortName: text("sort_name").notNull(),
  status: text("status").notNull(),
  mergedInto: text("merged_into"),
  isOwner: integer("is_owner").notNull(),
  pinned: integer("pinned").notNull(),
  hidden: integer("hidden").notNull(),
  projectStatus: text("project_status"),
  dueAt: text("due_at"),
  summary: text("summary"),
  summaryAt: text("summary_at"),
  summaryHash: text("summary_hash"),
  notes: text("notes"),
  lastInteractionAt: text("last_interaction_at"),
  cardPath: text("card_path"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const graphIdentifiers = sqliteTable(
  "graph_identifiers",
  {
    kind: text("kind").notNull(),
    valueNorm: text("value_norm").notNull(),
    valueDisplay: text("value_display").notNull(),
    entityId: text("entity_id").notNull(),
    source: text("source").notNull(),
    linkedBy: text("linked_by").notNull(),
    verified: integer("verified").notNull(),
    shared: integer("shared").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.valueNorm] })],
);

export const graphAliases = sqliteTable(
  "graph_aliases",
  {
    entityId: text("entity_id").notNull(),
    aliasNorm: text("alias_norm").notNull(),
    alias: text("alias").notNull(),
    source: text("source").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.entityId, t.aliasNorm] })],
);

export const graphFacts = sqliteTable("graph_facts", {
  id: text("id").primaryKey(),
  entityId: text("entity_id").notNull(),
  attribute: text("attribute").notNull(),
  value: text("value").notNull(),
  provenance: text("provenance").notNull(),
  confidence: real("confidence").notNull(),
  sources: text("sources").notNull(),
  evidence: text("evidence"),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  recordedAt: text("recorded_at").notNull(),
  supersededBy: text("superseded_by"),
  retractedAt: text("retracted_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const graphEdges = sqliteTable("graph_edges", {
  id: text("id").primaryKey(),
  src: text("src").notNull(),
  dst: text("dst").notNull(),
  rel: text("rel").notNull(),
  label: text("label"),
  provenance: text("provenance").notNull(),
  confidence: real("confidence").notNull(),
  sources: text("sources").notNull(),
  validFrom: text("valid_from").notNull(),
  validTo: text("valid_to"),
  supersededBy: text("superseded_by"),
  retractedAt: text("retracted_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const graphInteractions = sqliteTable("graph_interactions", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  source: text("source").notNull(),
  externalRef: text("external_ref").notNull(),
  occurredAt: text("occurred_at").notNull(),
  direction: text("direction").notNull(),
  subject: text("subject"),
  threadKey: text("thread_key"),
  link: text("link"),
  projectId: text("project_id"),
  createdAt: text("created_at").notNull(),
});

export const graphParticipants = sqliteTable(
  "graph_participants",
  {
    interactionId: text("interaction_id").notNull(),
    entityId: text("entity_id").notNull(),
    role: text("role").notNull(),
  },
  (t) => [primaryKey({ columns: [t.interactionId, t.entityId, t.role] })],
);

export const graphLoops = sqliteTable("graph_loops", {
  id: text("id").primaryKey(),
  direction: text("direction").notNull(),
  text: text("text").notNull(),
  evidence: text("evidence"),
  counterpartId: text("counterpart_id"),
  projectId: text("project_id"),
  dueAt: text("due_at"),
  status: text("status").notNull(),
  sourceInteractionId: text("source_interaction_id"),
  provenance: text("provenance").notNull(),
  confidence: real("confidence").notNull(),
  detectedBy: text("detected_by").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  closedAt: text("closed_at"),
  closedBy: text("closed_by"),
});

export const graphSuggestions = sqliteTable("graph_suggestions", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  entityIds: text("entity_ids").notNull(),
  name: text("name"),
  reason: text("reason").notNull(),
  status: text("status").notNull(),
  keyHash: text("key_hash").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const graphFeedback = sqliteTable("graph_feedback", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  entityId: text("entity_id"),
  otherId: text("other_id"),
  keyHash: text("key_hash"),
  createdAt: text("created_at").notNull(),
});

export const graphBlocklist = sqliteTable(
  "graph_blocklist",
  {
    kind: text("kind").notNull(),
    valueHash: text("value_hash").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.valueHash] })],
);

export const graphCursors = sqliteTable("graph_cursors", {
  source: text("source").primaryKey(),
  cursor: text("cursor").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const s07Schema = {
  memoryFiles,
  memoryClaims,
  memoryChunks,
  memoryJobs,
  memoryState,
  memoryRecalls,
  graphEntities,
  graphIdentifiers,
  graphAliases,
  graphFacts,
  graphEdges,
  graphInteractions,
  graphParticipants,
  graphLoops,
  graphSuggestions,
  graphFeedback,
  graphBlocklist,
  graphCursors,
};

export type MemoryFileRow = typeof memoryFiles.$inferSelect;
export type MemoryClaimRow = typeof memoryClaims.$inferSelect;
export type MemoryChunkRow = typeof memoryChunks.$inferSelect;
export type MemoryJobRow = typeof memoryJobs.$inferSelect;
