/**
 * drizzle mirror of the security-state tables (owner: `apps/gateway/src/security`,
 * migrations/202611051800_gateway_security-seal.sql); see the header of `schema.ts` for the
 * conventions. The Gateway reads and writes them with raw SQL from its TEMP triggers; this mirror
 * keeps the schema-parity test whole.
 */
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const securitySeal = sqliteTable("security_seal", {
  id: integer("id").primaryKey(),
  format: integer("format").notNull(),
  keyId: text("key_id").notNull(),
  agg: text("agg").notNull(),
  state: text("state").notNull(),
  sealedAt: text("sealed_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const securityLedger = sqliteTable(
  "security_ledger",
  {
    tbl: text("tbl").notNull(),
    pk: text("pk").notNull(),
    row: text("row").notNull(),
    mac: text("mac").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tbl, t.pk] })],
);

export const securityRequests = sqliteTable("security_requests", {
  id: text("id").primaryKey(),
  op: text("op").notNull(),
  params: text("params").notNull(),
  status: text("status").notNull(),
  outcome: text("outcome"),
  recoveryId: text("recovery_id"),
  notBefore: text("not_before"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const securityRecoveries = sqliteTable("security_recoveries", {
  id: text("id").primaryKey(),
  op: text("op").notNull(),
  params: text("params").notNull(),
  status: text("status").notNull(),
  seenAt: text("seen_at").notNull(),
  notBefore: text("not_before").notNull(),
  decidedAt: text("decided_at"),
  decidedByDeviceId: text("decided_by_device_id"),
  outcome: text("outcome"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const securityAlerts = sqliteTable("security_alerts", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  severity: text("severity").notNull(),
  details: text("details").notNull(),
  createdAt: text("created_at").notNull(),
  notifiedAt: text("notified_at"),
  acknowledgedAt: text("acknowledged_at"),
  acknowledgedByDeviceId: text("acknowledged_by_device_id"),
});

export const securitySchema = {
  securitySeal,
  securityLedger,
  securityRequests,
  securityRecoveries,
  securityAlerts,
};
