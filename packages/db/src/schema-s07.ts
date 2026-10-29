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
  // Everything memory (202610281200_memory_everything.sql).
  subjectKind: text("subject_kind").notNull(),
  sensitivity: text("sensitivity").notNull(),
  review: text("review").notNull(),
  firstSeenAt: text("first_seen_at"),
  lastSeenAt: text("last_seen_at"),
  runId: text("run_id"),
  extractor: text("extractor"),
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
  role: text("role"),
  review: text("review").notNull(),
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
    hint: text("hint"),
  },
  (t) => [primaryKey({ columns: [t.kind, t.valueHash] })],
);

export const graphCursors = sqliteTable("graph_cursors", {
  source: text("source").primaryKey(),
  cursor: text("cursor").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// --- Everything memory (202610281200_memory_everything.sql; docs/design/everything-memory-2026.md) ---

export const graphCitations = sqliteTable("graph_citations", {
  id: text("id").primaryKey(),
  targetKind: text("target_kind").notNull(),
  targetId: text("target_id").notNull(),
  source: text("source").notNull(),
  docId: text("doc_id"),
  sourceRef: text("source_ref").notNull(),
  quote: text("quote").notNull(),
  start: integer("start").notNull(),
  end: integer("end").notNull(),
  sourceHash: text("source_hash").notNull(),
  authorEntityId: text("author_entity_id"),
  provenance: text("provenance").notNull(),
  observedAt: text("observed_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const memoryRuns = sqliteTable("memory_runs", {
  id: text("id").primaryKey(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  model: text("model"),
  sources: text("sources").notNull(),
  itemsRead: integer("items_read").notNull(),
  itemsFiltered: integer("items_filtered").notNull(),
  batches: integer("batches").notNull(),
  tokensIn: integer("tokens_in").notNull(),
  tokensOut: integer("tokens_out").notNull(),
  factsProposed: integer("facts_proposed").notNull(),
  factsDropped: text("facts_dropped").notNull(),
  quarantined: integer("quarantined").notNull(),
  deferred: integer("deferred").notNull(),
  error: text("error"),
});

export const memoryQuarantine = sqliteTable("memory_quarantine", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  sourceRef: text("source_ref").notNull(),
  senderEntityId: text("sender_entity_id"),
  reasons: text("reasons").notNull(),
  excerpt: text("excerpt").notNull(),
  createdAt: text("created_at").notNull(),
  decided: text("decided"),
  decidedAt: text("decided_at"),
});

export const graphExclusions = sqliteTable(
  "graph_exclusions",
  {
    kind: text("kind").notNull(),
    valueHash: text("value_hash").notNull(),
    mode: text("mode").notNull(),
    hint: text("hint"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.valueHash] })],
);

export const memoryClaimSubjects = sqliteTable(
  "memory_claim_subjects",
  {
    claimId: text("claim_id").notNull(),
    entityId: text("entity_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.claimId, t.entityId] })],
);

export const memoryNeverRules = sqliteTable(
  "memory_never_rules",
  {
    kind: text("kind").notNull(),
    entityId: text("entity_id").notNull(),
    attribute: text("attribute").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.entityId, t.attribute] })],
);

// --- The teaching loop (202610251600_memory_teaching.sql; docs/agent/teaching-loop-2026.md §3) ---

export const feedbackEvents = sqliteTable("feedback_events", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  target: text("target").notNull(),
  threadId: text("thread_id"),
  text: text("text"),
  reason: text("reason"),
  scope: text("scope"),
  detail: text("detail"),
  surface: text("surface").notNull(),
  lessonId: text("lesson_id"),
  createdAt: text("created_at").notNull(),
});

export const lessons = sqliteTable("lessons", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  origin: text("origin").notNull(),
  statement: text("statement").notNull(),
  scope: text("scope").notNull(),
  destination: text("destination").notNull(),
  destinationKey: text("destination_key").notNull(),
  previous: text("previous"),
  value: text("value").notNull(),
  sources: text("sources").notNull(),
  confidence: real("confidence").notNull(),
  status: text("status").notNull(),
  refinedCount: integer("refined_count").notNull().default(0),
  supersedes: text("supersedes"),
  approvalId: text("approval_id"),
  fingerprint: text("fingerprint").notNull(),
  lastAppliedAt: text("last_applied_at"),
  lastConfirmedAt: text("last_confirmed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  confirmedAt: text("confirmed_at"),
  forgottenAt: text("forgotten_at"),
});

export const feedbackWeekly = sqliteTable(
  "feedback_weekly",
  {
    week: text("week").notNull(),
    kind: text("kind").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.week, t.kind] })],
);

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
  graphCitations,
  memoryRuns,
  memoryQuarantine,
  graphExclusions,
  memoryClaimSubjects,
  memoryNeverRules,
  feedbackEvents,
  lessons,
  feedbackWeekly,
};

export type MemoryFileRow = typeof memoryFiles.$inferSelect;
export type MemoryClaimRow = typeof memoryClaims.$inferSelect;
export type MemoryChunkRow = typeof memoryChunks.$inferSelect;
export type MemoryJobRow = typeof memoryJobs.$inferSelect;
