import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppleHelper, MemoryConnectorStore } from "@psyche/connectors";
import { getLibraryItem, openDb, type PsycheDb } from "@psyche/db";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeConnectors, stagedImporter } from "../src/compose/connectors.ts";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { indexedConnectorLibrary } from "../src/compose/library.ts";
import { adminClient, desktopClient, ik, type TestClient } from "./helpers.ts";

/** #727: `connectors.configure` over the wire, and staged Mail attachments into the Library. */

const helper: AppleHelper = {
  nodeId: "node_mac",
  capabilities: ["shortcuts.list", "shortcuts.run", "permissions.status"],
  invoke: async () => ({ ok: true, result: { shortcuts: [] } }),
};

let base = "";
let home = "";
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "psyche-configure-")));
  home = join(base, "home");
  await mkdir(home, { recursive: true });
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  await rm(base, { recursive: true, force: true });
});

describe("connectors.configure (#727)", () => {
  it("merges settings, removes null keys, refuses secrets and announces connectors.updated", async () => {
    const store = new MemoryConnectorStore();
    composed = await composeGateway({
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: [(s) => composeConnectors(s, { store, appleHelper: () => helper, syncIntervalMs: 0 })],
    });
    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    const { connector } = (await owner.call(
      "connectors.connect",
      { catalogueId: "apple-shortcuts", scopeMode: "read_act" },
      ik(),
    )) as { connector: { id: string } };
    const before = owner.eventsNamed("connectors.updated").length;

    const r = (await owner.call(
      "connectors.configure",
      { connectorId: connector.id, config: { shortcutRules: { S1: "allow" }, extra: 1 } },
      ik(),
    )) as { connector: { config: Record<string, unknown> } };
    expect(r.connector.config).toMatchObject({ shortcutRules: { S1: "allow" }, extra: 1 });
    const again = (await owner.call(
      "connectors.configure",
      { connectorId: connector.id, config: { extra: null } },
      ik(),
    )) as { connector: { config: Record<string, unknown> } };
    expect(again.connector.config).not.toHaveProperty("extra");
    expect((await store.get(connector.id))?.config).toMatchObject({
      shortcutRules: { S1: "allow" },
    });

    await expect(
      owner.call(
        "connectors.configure",
        { connectorId: connector.id, config: { apiToken: "tok_live_abc" } },
        ik(),
      ),
    ).rejects.toThrow(/"reason":"secret_in_config"/);
    expect(JSON.stringify((await store.get(connector.id))?.config)).not.toContain("tok_live_abc");

    const updates = () => owner.eventsNamed("connectors.updated").slice(before);
    const until = Date.now() + 2_000;
    while (updates().length < 2 && Date.now() < until) await new Promise((x) => setTimeout(x, 10));
    expect(updates()).toHaveLength(2);
    expect(updates()[0]).toMatchObject({
      payload: { reason: "updated", connector: { id: connector.id } },
    });
  });
});

describe("trusted sources (security §3.6)", () => {
  const lists = {
    lists: [
      { id: "L1", title: "Home", source: "iCloud", writable: true },
      { id: "L2", title: "Family", source: "iCloud", writable: false },
    ],
  };
  const remindersHelper: AppleHelper = {
    nodeId: "node_mac",
    capabilities: ["reminders.list_lists", "reminders.list", "permissions.status"],
    invoke: async () => ({ ok: true, result: lists }),
  };

  async function compose() {
    composed = await composeGateway({
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
      parts: [
        (s) =>
          composeConnectors(s, {
            store: new MemoryConnectorStore(),
            appleHelper: () => remindersHelper,
            syncIntervalMs: 0,
          }),
      ],
    });
    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    const { connector } = (await owner.call(
      "connectors.connect",
      { catalogueId: "apple-reminders", scopeMode: "read_act" },
      ik(),
    )) as { connector: { id: string } };
    return { owner, id: connector.id };
  }

  it("the owner's toggle is audited, and a shared source cannot be marked", async () => {
    const { owner, id } = await compose();
    await expect(
      owner.call(
        "connectors.configure",
        { connectorId: id, config: { trustedSources: ["L2"] } },
        ik(),
      ),
    ).rejects.toThrow(/shared_source/);
    await owner.call(
      "connectors.configure",
      { connectorId: id, config: { trustedSources: ["L1"] } },
      ik(),
    );
    const { changes } = (await owner.call("audit.changes", {}, ik())) as {
      changes: {
        category: string;
        target: { connector?: string; object?: string };
        actor: { type: string };
      }[];
    };
    const row = changes.find((c) => c.target.object === "trustedSources");
    expect(row).toMatchObject({ category: "connector", actor: { type: "owner" } });
    expect(row?.target.connector).toBe(id);
  });

  it("a device without the admin scope (what a turn runs as) cannot change trustedSources", async () => {
    const { id } = await compose();
    if (composed === null) throw new Error("not composed");
    const plain = await desktopClient(composed.gateway);
    clients.push(plain);
    await expect(
      plain.call(
        "connectors.configure",
        { connectorId: id, config: { trustedSources: ["L1"] } },
        ik(),
      ),
    ).rejects.toThrow();
    const { connector } = (await plain.call("connectors.get", { connectorId: id }, ik())) as {
      connector: { config: Record<string, unknown> };
    };
    expect(connector.config).not.toHaveProperty("trustedSources");
  });
});

describe("staged Mail attachments into the Library (#727)", () => {
  let db: PsycheDb;
  beforeEach(() => {
    db = openDb(":memory:");
  });
  afterEach(() => db.close());

  it("imports a staged file quarantined, then removes it and its folder", async () => {
    const dir = join(home, "helper", "staging", "mail-1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "bill.pdf"), "%PDF-1.7 bill");
    const importStaged = stagedImporter(home, indexedConnectorLibrary(db, home));
    const id = await importStaged(
      { stagedPath: join(dir, "bill.pdf"), name: "bill.pdf", mimeType: "application/pdf" },
      { connectorId: "apple-mail-1", ref: "m1" },
    );
    const item = getLibraryItem(db, id);
    expect(item).toMatchObject({
      kind: "document",
      name: "bill.pdf",
      mime: "application/pdf",
      size: 13,
      origin: "connector",
      quarantined: true,
      path: `quarantine/${id}-bill.pdf`,
    });
    expect(await readFile(join(home, "library", "quarantine", `${id}-bill.pdf`), "utf8")).toBe(
      "%PDF-1.7 bill",
    );
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses paths outside the staging folder and symlinks", async () => {
    const staging = join(home, "helper", "staging");
    await mkdir(staging, { recursive: true });
    await writeFile(join(home, "secret.txt"), "nope");
    await symlink(join(home, "secret.txt"), join(staging, "link.txt"));
    const importStaged = stagedImporter(home, indexedConnectorLibrary(db, home));
    const source = { connectorId: "apple-mail-1", ref: "m1" };
    const file = (stagedPath: string) => ({ stagedPath, name: "x.txt", mimeType: "text/plain" });
    await expect(importStaged(file(join(home, "secret.txt")), source)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      importStaged(file(join(staging, "..", "..", "secret.txt")), source),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(importStaged(file(join(staging, "link.txt")), source)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(existsSync(join(home, "secret.txt"))).toBe(true);
    expect(existsSync(join(home, "library"))).toBe(false);
  });
});
