import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppleHelper, type ConnectorRecord, MemoryConnectorStore } from "@psyche/connectors";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { composeConnectors } from "../src/compose/connectors.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** #549: one-per-machine connectors are never duplicated, and old duplicates go at start. */

const row = (id: string, createdAt: string): ConnectorRecord => ({
  id,
  type: "apple:mail",
  label: "Apple Mail",
  account: "This Mac",
  scopes: ["mail.search"],
  scopeMode: "read",
  actionMatrix: {},
  credentialId: null,
  status: "connected",
  config: {},
  lastSync: null,
  createdAt,
  updatedAt: createdAt,
});

const helper: AppleHelper = {
  nodeId: "node_mac",
  capabilities: ["mail.search", "mail.read", "permissions.status"],
  invoke: async (capability) =>
    capability === "permissions.status"
      ? { ok: true, result: { automation: { "com.apple.mail": "granted" } } }
      : { ok: true, result: { messages: [] } },
};

let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("connector duplicates (#549)", () => {
  it("removes duplicates at start (oldest kept, audited) and refuses a second Apple Mail", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-dedupe-"));
    const store = new MemoryConnectorStore();
    await store.put(row("mail-old", "2026-10-20T10:00:00.000Z"));
    await store.put(row("mail-new", "2026-10-21T10:00:00.000Z"));
    composed = await composeGateway({
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: [(s) => composeConnectors(s, { store, appleHelper: () => helper, syncIntervalMs: 0 })],
    });
    const owner = await adminClient(composed.gateway);
    clients.push(owner);

    // start() dedupes before restoring.
    const until = Date.now() + 5_000;
    while ((await store.list()).length > 1 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await store.list()).map((r) => r.id)).toEqual(["mail-old"]);
    const audits = await composed.audit.list({ kind: "connector.duplicate_removed" });
    expect(audits.map((a) => a.data)).toEqual([
      { connectorId: "mail-new", type: "apple:mail", kept: "mail-old" },
    ]);

    await expect(
      owner.call("connectors.connect", { catalogueId: "apple-mail", scopeMode: "read" }, ik()),
    ).rejects.toThrow(/"code":"conflict".*"reason":"already_connected".*"connectorId":"mail-old"/);
  });
});
