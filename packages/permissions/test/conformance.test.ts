import { createAuditLog, Receipts, SqliteReceiptStore } from "@psyche/audit";
import { openDb } from "@psyche/db";
import { describePermissionBrokerConformance } from "@psyche/testing/conformance";
import { createPermissionBroker, SqlitePermissionStore } from "../src/index.ts";
import { approvers } from "./helpers.ts";

describePermissionBrokerConformance("PsychePermissionBroker (memory)", ({ clock, deniedTools }) =>
  createPermissionBroker({
    approvers: approvers(),
    clock,
    audit: createAuditLog({ clock }),
    policy: { deny: [...deniedTools] },
  }),
);

describePermissionBrokerConformance("PsychePermissionBroker (sqlite)", ({ clock, deniedTools }) => {
  const db = openDb(":memory:");
  const audit = createAuditLog({ clock });
  return createPermissionBroker({
    approvers: approvers(),
    clock,
    audit,
    store: new SqlitePermissionStore(db.sqlite),
    receipts: new Receipts({ clock, audit, store: new SqliteReceiptStore(db.sqlite) }),
    policy: { deny: [...deniedTools] },
  });
});
