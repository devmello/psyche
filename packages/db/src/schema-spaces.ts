/**
 * drizzle mirror of the Spaces tables (migrations/202611201000_gateway_spaces.sql). See the
 * header of `schema.ts` for the conventions: the SQL file owns constraints, indexes and defaults.
 */
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The migration declares `id TEXT PRIMARY KEY` without NOT NULL (SQLite allows NULL ids in a
// non-INTEGER primary key), so `id` is a table-level key here: `.primaryKey()` would add notNull.
export const spaces = sqliteTable(
  "spaces",
  {
    id: text("id"),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon"),
    instructions: text("instructions").notNull().default(""),
    entityId: text("entity_id"),
    defaultPermissionMode: text("default_permission_mode"),
    connectorScope: text("connector_scope"),
    private: integer("private").notNull().default(0),
    sort: integer("sort").notNull(),
    archivedAt: text("archived_at"),
    createdFrom: text("created_from").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    instructionsRev: integer("instructions_rev").notNull().default(1),
    /** JSON array of the automation ids the archive paused. */
    pausedAutomationIds: text("paused_automation_ids"),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);

export const spaceFolders = sqliteTable(
  "space_folders",
  {
    spaceId: text("space_id").notNull(),
    path: text("path").notNull(),
    real: text("real").notNull(),
    mode: text("mode").notNull(),
    automationsWrite: integer("automations_write").notNull().default(0),
    addedAt: text("added_at").notNull(),
    addedByDevice: text("added_by_device"),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.path] })],
);

export const spaceLinks = sqliteTable(
  "space_links",
  {
    id: text("id"),
    spaceId: text("space_id").notNull(),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    label: text("label").notNull(),
    labelProvenance: text("label_provenance").notNull(),
    addedBy: text("added_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);

export const spaceTrackers = sqliteTable(
  "space_trackers",
  {
    spaceId: text("space_id").notNull(),
    widgetId: text("widget_id").notNull(),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),
    refresh: text("refresh"),
    staleAfterS: integer("stale_after_s"),
    refreshedAt: text("refreshed_at"),
    addedBy: text("added_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.widgetId] })],
);

export const spaceProposals = sqliteTable(
  "space_proposals",
  {
    id: text("id"),
    name: text("name").notNull(),
    reason: text("reason").notNull(),
    entityId: text("entity_id"),
    threadIds: text("thread_ids").notNull(),
    taint: text("taint").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);

export const spacesSchema = {
  spaces,
  spaceFolders,
  spaceLinks,
  spaceTrackers,
  spaceProposals,
};
