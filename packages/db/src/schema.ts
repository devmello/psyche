/**
 * drizzle table definitions mirroring `migrations/*.sql`. The SQL files are the source of truth
 * for DDL (constraints, indexes, defaults); these definitions exist for typed queries only and a
 * test (`test/schema-parity.test.ts`) compares their column names with `PRAGMA table_info`.
 *
 * Columns are declared in their storage representation (JSON as TEXT, booleans as INTEGER 0/1,
 * keys as BLOB) so drizzle rows and raw better-sqlite3 rows look the same. `src/mappers.ts`
 * converts rows into the `@psyche/protocol` shapes.
 */
import { blob, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { s04Schema } from "./schema-s04.ts";
import { s07Schema } from "./schema-s07.ts";

export * from "./schema-s04.ts";
export * from "./schema-s07.ts";

// §1 Identity --------------------------------------------------------------------------------

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  platform: text("platform").notNull(),
  role: text("role").notNull(),
  publicKey: blob("public_key", { mode: "buffer" }).notNull(),
  tokenHash: blob("token_hash", { mode: "buffer" }),
  scopes: text("scopes").notNull(),
  pairedAt: text("paired_at"),
  lastSeenAt: text("last_seen_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const nodes = sqliteTable("nodes", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull(),
  kind: text("kind").notNull(),
  capabilities: text("capabilities").notNull(),
  status: text("status").notNull(),
  lastHeartbeatAt: text("last_heartbeat_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const pairingRequests = sqliteTable("pairing_requests", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  code: text("code").notNull(),
  deviceId: text("device_id"),
  channelId: text("channel_id"),
  senderId: text("sender_id"),
  display: text("display").notNull(),
  status: text("status").notNull(),
  expiresAt: text("expires_at").notNull(),
  decidedAt: text("decided_at"),
  decidedByDeviceId: text("decided_by_device_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// §2 Threads, messages, runs, tool calls ------------------------------------------------------

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  titleSource: text("title_source").notNull(),
  parentThreadId: text("parent_thread_id"),
  forkedFromMessageId: text("forked_from_message_id"),
  sessionKey: text("session_key").notNull(),
  personaOverlay: text("persona_overlay"),
  permissionMode: text("permission_mode").notNull(),
  modelRef: text("model_ref"),
  pinned: integer("pinned").notNull(),
  archivedAt: text("archived_at"),
  expiresAt: text("expires_at"),
  activeWriterRunId: text("active_writer_run_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastMessageAt: text("last_message_at"),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  seq: integer("seq").notNull(),
  role: text("role").notNull(),
  blocks: text("blocks").notNull(),
  providerNative: text("provider_native"),
  provenance: text("provenance").notNull(),
  replyToMessageId: text("reply_to_message_id"),
  channelRef: text("channel_ref"),
  runId: text("run_id"),
  createdAt: text("created_at").notNull(),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  status: text("status").notNull(),
  modelRef: text("model_ref").notNull(),
  attempt: integer("attempt").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  error: text("error"),
  usage: text("usage").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const toolCalls = sqliteTable("tool_calls", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  messageId: text("message_id"),
  tool: text("tool").notNull(),
  paramsRedacted: text("params_redacted").notNull(),
  paramsHash: text("params_hash").notNull(),
  sideEffect: text("side_effect").notNull(),
  target: text("target"),
  decision: text("decision"),
  decisionRule: text("decision_rule"),
  approvalId: text("approval_id"),
  taintIn: integer("taint_in").notNull(),
  taintOut: integer("taint_out").notNull(),
  resultRef: text("result_ref"),
  provenanceOut: text("provenance_out").notNull(),
  receiptId: text("receipt_id"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// §10 Settings and usage ----------------------------------------------------------------------

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const usage = sqliteTable("usage", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  job: text("job"),
  modelRef: text("model_ref").notNull(),
  input: integer("input").notNull(),
  output: integer("output").notNull(),
  cacheRead: integer("cache_read").notNull(),
  cacheWrite: integer("cache_write").notNull(),
  reasoning: integer("reasoning").notNull(),
  costUsd: real("cost_usd").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Every table defined by this package, keyed by drizzle name. */
export const schema = {
  devices,
  nodes,
  pairingRequests,
  threads,
  messages,
  runs,
  toolCalls,
  settings,
  usage,
  ...s04Schema,
  ...s07Schema,
};
export type Schema = typeof schema;

export type DeviceRow = typeof devices.$inferSelect;
export type NewDeviceRow = typeof devices.$inferInsert;
export type NodeRow = typeof nodes.$inferSelect;
export type NewNodeRow = typeof nodes.$inferInsert;
export type PairingRequestRow = typeof pairingRequests.$inferSelect;
export type NewPairingRequestRow = typeof pairingRequests.$inferInsert;
export type ThreadRow = typeof threads.$inferSelect;
export type NewThreadRow = typeof threads.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
export type ToolCallRow = typeof toolCalls.$inferSelect;
export type NewToolCallRow = typeof toolCalls.$inferInsert;
export type SettingRow = typeof settings.$inferSelect;
export type NewSettingRow = typeof settings.$inferInsert;
export type UsageRow = typeof usage.$inferSelect;
export type NewUsageRow = typeof usage.$inferInsert;
