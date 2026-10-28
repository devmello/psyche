/**
 * drizzle table definitions mirroring `migrations/*.sql`. The SQL files are the source of truth
 * for DDL (constraints, indexes, defaults); these definitions exist for typed queries only and a
 * test (`test/schema-parity.test.ts`) compares their column names with `PRAGMA table_info`.
 *
 * Columns are declared in their storage representation (JSON as TEXT, booleans as INTEGER 0/1,
 * keys as BLOB) so drizzle rows and raw better-sqlite3 rows look the same. `src/mappers.ts`
 * converts rows into the `@psyche/protocol` shapes.
 */
import { blob, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { connectorsSchema } from "./schema-connectors.ts";
import { notificationsSchema } from "./schema-notifications.ts";
import { permissionsSchema } from "./schema-permissions.ts";
import { s04Schema } from "./schema-s04.ts";
import { s07Schema } from "./schema-s07.ts";
import { s15Schema } from "./schema-s15.ts";
import { s16Schema } from "./schema-s16.ts";

export * from "./schema-connectors.ts";
export * from "./schema-notifications.ts";
export * from "./schema-s04.ts";
export * from "./schema-s07.ts";
export * from "./schema-s15.ts";
export * from "./schema-s16.ts";

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
  publicKeyFingerprint: text("public_key_fingerprint"),
  transport: text("transport"),
  remoteAddress: text("remote_address"),
});

// §8 Channels and identities (owner: packages/channels, S10) ----------------------------------

export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  account: text("account").notNull(),
  dmPolicy: text("dm_policy").notNull(),
  allowFrom: text("allow_from").notNull(),
  groupAllowFrom: text("group_allow_from").notNull(),
  requireMention: integer("require_mention").notNull(),
  ownerIds: text("owner_ids").notNull(),
  dmScope: text("dm_scope").notNull(),
  nodeId: text("node_id"),
  status: text("status").notNull(),
  config: text("config").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const identities = sqliteTable("identities", {
  id: text("id").primaryKey(),
  display: text("display").notNull(),
  links: text("links").notNull(),
  delegatedPersona: text("delegated_persona"),
  toolAllow: text("tool_allow"),
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
  /** 1 for a chat the owner opened with "New chat" (migration 202610271300). */
  userCreated: integer("user_created").notNull().default(0),
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
  // 202610261300_gateway_messages-lessons-applied.sql (teaching loop, LessonRef[] JSON)
  lessonsApplied: text("lessons_applied"),
  /** `voice` for a message the owner spoke (migration 202610261900); NULL otherwise. */
  via: text("via"),
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
  // Run trace (migration 202610251300_gateway_run-trace).
  kind: text("kind"),
  title: text("title"),
  parentRunId: text("parent_run_id"),
  rootRunId: text("root_run_id"),
  taskId: text("task_id"),
  automationRunId: text("automation_run_id"),
  origin: text("origin"),
  budget: text("budget"),
  deadline: text("deadline"),
  specialist: text("specialist"),
  note: text("note"),
  stepCount: integer("step_count").notNull().default(0),
  currentStepId: text("current_step_id"),
  lastStepAt: text("last_step_at"),
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
  stepId: text("step_id"),
});

export const chatQueue = sqliteTable("chat_queue", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  position: integer("position").notNull(),
  content: text("content").notNull(),
  attachments: text("attachments").notNull(),
  deviceId: text("device_id"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  provenance: text("provenance").notNull(),
  fromThreadId: text("from_thread_id"),
});

export const toolPayloads = sqliteTable("tool_payloads", {
  id: text("id").primaryKey(),
  toolCallId: text("tool_call_id").notNull(),
  kind: text("kind").notNull(),
  mime: text("mime").notNull(),
  data: blob("data", { mode: "buffer" }).notNull(),
  createdAt: text("created_at").notNull(),
  stepId: text("step_id"),
  truncated: integer("truncated").notNull().default(0),
});

/** Run-trace steps (run trace §4.2): the RunStep as JSON plus the retained thinking text. */
export const runSteps = sqliteTable(
  "run_steps",
  {
    runId: text("run_id").notNull(),
    id: text("id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    toolCallId: text("tool_call_id"),
    data: text("data").notNull(),
    textFull: text("text_full"),
    textExpiresAt: text("text_expires_at"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.id] })],
);

/** Frames Psyche saw during a run (run trace §4.2). */
export const runFrames = sqliteTable(
  "run_frames",
  {
    runId: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    at: text("at").notNull(),
    stepId: text("step_id"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    path: text("path"),
    expiredAt: text("expired_at"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

/** WebAuthn passkeys per device (issue #79). */
export const passkeys = sqliteTable("passkeys", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull(),
  credentialId: text("credential_id").notNull(),
  publicKey: blob("public_key", { mode: "buffer" }).notNull(),
  counter: integer("counter").notNull(),
  transports: text("transports").notNull(),
  name: text("name").notNull(),
  backedUp: integer("backed_up").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
});

/** The agent loop's per-thread state (issue #52), JSON. */
export const agentThreadState = sqliteTable("agent_thread_state", {
  threadId: text("thread_id").primaryKey(),
  state: text("state").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// §11 Idempotency -----------------------------------------------------------------------------

export const gatewayIdempotency = sqliteTable("gateway_idempotency", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull(),
  method: text("method").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  paramsHash: text("params_hash").notNull(),
  result: text("result").notNull(),
  createdAt: text("created_at").notNull(),
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
  stepId: text("step_id"),
});

// §9 Library index (P4; migration 202610221000_gateway_library-items) -------------------------

export const libraryItems = sqliteTable("library_items", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  path: text("path").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  origin: text("origin").notNull(),
  threadId: text("thread_id"),
  taskId: text("task_id"),
  tags: text("tags").notNull(),
  textExtractRef: text("text_extract_ref"),
  quarantined: integer("quarantined").notNull(),
  source: text("source"),
  createdAt: text("created_at").notNull(),
});

// Canvas artifacts (chat-experience-2026 §4.4; migration 202610262200_gateway_artifacts) ---------

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  libraryItemId: text("library_item_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  nameSlug: text("name_slug").notNull(),
  language: text("language"),
  threadId: text("thread_id"),
  /** Origin (migration 202610271200): the run that made it and the message holding its block. */
  runId: text("run_id"),
  messageId: text("message_id"),
  untrusted: integer("untrusted").notNull(),
  version: integer("version").notNull(),
  content: text("content").notNull(),
  view: text("view"),
  bytes: integer("bytes").notNull(),
  hash: text("hash").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const artifactVersions = sqliteTable(
  "artifact_versions",
  {
    artifactId: text("artifact_id").notNull(),
    version: integer("version").notNull(),
    author: text("author").notNull(),
    kind: text("kind").notNull(),
    ops: text("ops"),
    snapshot: text("snapshot"),
    view: text("view"),
    bytes: integer("bytes").notNull(),
    hash: text("hash").notNull(),
    summary: text("summary").notNull(),
    runId: text("run_id"),
    toolCallId: text("tool_call_id"),
    restoredFrom: integer("restored_from"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.version] })],
);

// §6 Credentials (metadata mirror; owner S06, migration 202610191000_vault_credentials) --------

export const credentialMeta = sqliteTable("credential_meta", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  bindings: text("bindings").notNull(),
  ownerConnectorId: text("owner_connector_id"),
  lastUsedAt: text("last_used_at"),
  useCount: integer("use_count").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const credentialUses = sqliteTable("credential_uses", {
  id: text("id").primaryKey(),
  credentialId: text("credential_id").notNull(),
  taskId: text("task_id"),
  approvalId: text("approval_id"),
  executor: text("executor").notNull(),
  target: text("target").notNull(),
  outcome: text("outcome").notNull(),
  reason: text("reason"),
  createdAt: text("created_at").notNull(),
});

/** Every table defined by this package, keyed by drizzle name. */
export const schema = {
  devices,
  nodes,
  pairingRequests,
  channels,
  identities,
  threads,
  messages,
  runs,
  toolCalls,
  chatQueue,
  toolPayloads,
  runSteps,
  runFrames,
  gatewayIdempotency,
  agentThreadState,
  passkeys,
  settings,
  usage,
  libraryItems,
  artifacts,
  artifactVersions,
  ...s04Schema,
  ...permissionsSchema,
  credentialMeta,
  credentialUses,
  ...s07Schema,
  ...s15Schema,
  ...s16Schema,
  ...notificationsSchema,
  ...connectorsSchema,
};
export type Schema = typeof schema;

export type DeviceRow = typeof devices.$inferSelect;
export type NewDeviceRow = typeof devices.$inferInsert;
export type NodeRow = typeof nodes.$inferSelect;
export type NewNodeRow = typeof nodes.$inferInsert;
export type PairingRequestRow = typeof pairingRequests.$inferSelect;
export type NewPairingRequestRow = typeof pairingRequests.$inferInsert;
export type ChannelRow = typeof channels.$inferSelect;
export type IdentityRow = typeof identities.$inferSelect;
export type ThreadRow = typeof threads.$inferSelect;
export type NewThreadRow = typeof threads.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
export type ToolCallRow = typeof toolCalls.$inferSelect;
export type NewToolCallRow = typeof toolCalls.$inferInsert;
export type ChatQueueRow = typeof chatQueue.$inferSelect;
export type ToolPayloadRow = typeof toolPayloads.$inferSelect;
export type RunStepRow = typeof runSteps.$inferSelect;
export type RunFrameRow = typeof runFrames.$inferSelect;
export type GatewayIdempotencyRow = typeof gatewayIdempotency.$inferSelect;
export type SettingRow = typeof settings.$inferSelect;
export type NewSettingRow = typeof settings.$inferInsert;
export type CredentialMetaRow = typeof credentialMeta.$inferSelect;
export type CredentialUseRow = typeof credentialUses.$inferSelect;
export type UsageRow = typeof usage.$inferSelect;
export type NewUsageRow = typeof usage.$inferInsert;
export type LibraryItemRow = typeof libraryItems.$inferSelect;
export type NewLibraryItemRow = typeof libraryItems.$inferInsert;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersions.$inferSelect;
