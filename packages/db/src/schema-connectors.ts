/**
 * drizzle mirror of the connectors table (owner S09, `packages/connectors`;
 * migrations/202610241000_connectors_init.sql). See the header of `schema.ts`.
 */
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

// §8 Connectors: one row per configured connection; no secrets (tokens are vault items).

export const connectors = sqliteTable(
  "connectors",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    label: text("label").notNull(),
    account: text("account"),
    scopes: text("scopes").notNull(),
    scopeMode: text("scope_mode").notNull(),
    actionMatrix: text("action_matrix").notNull(),
    credentialId: text("credential_id"),
    status: text("status").notNull(),
    config: text("config").notNull(),
    lastSync: text("last_sync"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("connectors_type_idx").on(t.type)],
);

export const connectorsSchema = { connectors };

export type ConnectorRow = typeof connectors.$inferSelect;
