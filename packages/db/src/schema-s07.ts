/**
 * drizzle mirror of the memory tables (owner S07, `packages/memory`); see the header of
 * `schema.ts` for the conventions.
 */
import { blob, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

export const s07Schema = { memoryFiles, memoryClaims, memoryChunks, memoryJobs, memoryState };

export type MemoryFileRow = typeof memoryFiles.$inferSelect;
export type MemoryClaimRow = typeof memoryClaims.$inferSelect;
export type MemoryChunkRow = typeof memoryChunks.$inferSelect;
export type MemoryJobRow = typeof memoryJobs.$inferSelect;
