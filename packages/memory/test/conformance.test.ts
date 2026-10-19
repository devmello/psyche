import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@psyche/db";
import { describeMemoryStoreConformance } from "@psyche/testing/conformance";
import { SqliteMemoryStore } from "../src/store.ts";

describeMemoryStoreConformance("SqliteMemoryStore", async (ctx) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "psyche-memory-conf-")));
  const db = openDb(":memory:");
  const store = new SqliteMemoryStore({
    sqlite: db.sqlite,
    workspaceDir: join(dir, "workspace"),
    clock: ctx.clock,
    timeZone: "UTC",
    templatesDir: null,
    approvals: (id) => id === ctx.approvedApprovalId,
  });
  await store.init();
  return store;
});
