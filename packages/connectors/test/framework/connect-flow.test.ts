import { readFileSync } from "node:fs";
import { PsycheError } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  type CatalogueEntry,
  type ConnectorEvent,
  type ConnectorFactory,
  ConnectorRegistry,
  type ConnectorStore,
  connectorsMigrationSql,
  type PendingAuthorization,
  SqliteConnectorStore,
} from "../../src/index.ts";

/** #505: a connect that returns before the owner finishes consent, durable records, restore. */

const entry: CatalogueEntry = {
  type: "oauthy",
  id: "oauthy",
  label: "OAuthy",
  description: "a connector with a browser sign-in",
  category: "first_party",
  vendor: "Psyche",
  auth: "oauth",
  scopes: { read: ["r"], read_act: ["r", "w"] },
  actions: [{ id: "oauthy.read", title: "Read", sideEffect: "read", defaultRule: "allow" }],
  available: true,
};

interface Consent {
  approve: () => void;
  deny: (reason: string) => void;
}

function oauthFactory(consents: Consent[], created: string[] = []): ConnectorFactory {
  return {
    entry,
    create: (record) => {
      if (record.config.broken === true) throw new PsycheError("invalid_params", "bad config");
      created.push(record.id);
      return {
        id: record.id,
        type: "oauthy",
        async connect(input) {
          await new Promise<void>((resolve, reject) => {
            consents.push({ approve: resolve, deny: (r) => reject(new Error(r)) });
            input.onAuthorization?.({
              url: "https://accounts.example/consent?state=s1",
              expiresAt: 300_000,
              opened: true,
            });
          });
          return { account: "owner@example.com", scopes: entry.scopes[input.scopeMode] };
        },
        async disconnect() {},
        actions: () => entry.actions,
        tools: () => [
          {
            name: "read",
            action: "oauthy.read",
            description: "r",
            inputSchema: { type: "object" },
            sideEffect: "read",
            execute: async () => ({ output: "ok", provenance: "untrusted" }),
          },
        ],
        async health() {
          return { ok: true, status: "connected", checkedAt: 0 };
        },
      };
    },
  };
}

function make(store?: ConnectorStore, created: string[] = []) {
  const consents: Consent[] = [];
  const events: ConnectorEvent[] = [];
  const tools: string[] = [];
  const registry = new ConnectorRegistry({
    factories: [oauthFactory(consents, created)],
    context: {
      clock: new FakeClock(),
      fetch,
      tokens: { load: async () => undefined, save: async () => {}, clear: async () => {} },
    },
    onEvent: (e) => events.push(e),
    tools: {
      list: () => [],
      get: () => undefined,
      register: (r) => {
        tools.push(r.spec.name);
        return () => void tools.splice(tools.indexOf(r.spec.name), 1);
      },
    },
    newId: () => "oauthy-1",
    ...(store === undefined ? {} : { store }),
  });
  return { registry, consents, events, tools };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("startConnect", () => {
  it("returns the consent page while signing in, and connects when the owner approves", async () => {
    const { registry, consents, events } = make();
    const { record, authorization } = await registry.startConnect({
      catalogueId: "oauthy",
      scopeMode: "read",
    });
    expect(record).toMatchObject({ id: "oauthy-1", status: "needs_auth", account: null });
    expect(authorization).toEqual<PendingAuthorization>({
      url: "https://accounts.example/consent?state=s1",
      expiresAt: 300_000,
      opened: true,
    });
    // Listed as signing in, never Connected before tokens exist.
    expect((await registry.list())[0]?.status).toBe("needs_auth");
    consents[0]?.approve();
    await tick();
    expect(await registry.get("oauthy-1")).toMatchObject({
      status: "connected",
      account: "owner@example.com",
      scopes: ["r"],
    });
    expect(events.at(-1)).toEqual({ type: "status", connectorId: "oauthy-1", status: "connected" });
  });

  it("a denied consent ends as an error status event, with nothing connected", async () => {
    const { registry, consents, events } = make();
    await registry.startConnect({ catalogueId: "oauthy", scopeMode: "read_act" });
    consents[0]?.deny("access_denied");
    await tick();
    expect((await registry.get("oauthy-1")).status).toBe("error");
    expect(events.at(-1)).toMatchObject({ status: "error", reason: "access_denied" });
  });

  it("refuses an unknown connector or mode before anything is stored", async () => {
    const { registry } = make();
    await expect(
      registry.startConnect({ catalogueId: "nope", scopeMode: "read" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      registry.startConnect({ catalogueId: "oauthy", scopeMode: "write" as never }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    expect(await registry.list()).toEqual([]);
  });
});

describe("restore", () => {
  it("brings stored connected records back with their tools, and marks a broken one error", async () => {
    const db = new Database(":memory:");
    const store = new SqliteConnectorStore(db, { migrate: true });
    const first = make(store);
    await first.registry.startConnect({ catalogueId: "oauthy", scopeMode: "read" });
    first.consents[0]?.approve();
    await tick();
    expect(first.tools).toEqual(["mcp__oauthy-1__read"]);

    // A new Gateway process over the same database: no sign-in runs again.
    const created: string[] = [];
    const second = make(store, created);
    expect(await second.registry.restore()).toBe(1);
    expect(second.tools).toEqual(["mcp__oauthy-1__read"]);
    expect(second.consents).toEqual([]);
    expect(created).toEqual(["oauthy-1"]);
    expect(await second.registry.restore()).toBe(0);

    const record = await store.get("oauthy-1");
    await store.put({
      ...(record as NonNullable<typeof record>),
      id: "oauthy-2",
      config: { broken: true },
    });
    const third = make(store);
    expect(await third.registry.restore()).toBe(1);
    expect((await store.get("oauthy-2"))?.status).toBe("error");
    expect(third.events).toContainEqual(
      expect.objectContaining({ connectorId: "oauthy-2", status: "error" }),
    );
  });
});

describe("SqliteConnectorStore", () => {
  it("round-trips a record, upserts, lists in creation order and deletes", async () => {
    const store = new SqliteConnectorStore(new Database(":memory:"), { migrate: true });
    const base = {
      id: "b",
      type: "google",
      label: "Google",
      account: "owner@example.com",
      scopes: ["openid", "email"],
      scopeMode: "read" as const,
      actionMatrix: { "gmail.send": "ask" as const },
      credentialId: null,
      status: "connected" as const,
      config: { clientId: "123.apps.googleusercontent.com", gmailScopes: "modify" },
      lastSync: { at: "2026-10-20T10:00:00.000Z" },
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
    };
    await store.put(base);
    await store.put({ ...base, id: "a", createdAt: "2026-10-20T11:00:00.000Z", lastSync: null });
    expect(await store.get("b")).toEqual(base);
    await store.put({ ...base, status: "disconnected", account: null });
    expect(await store.get("b")).toMatchObject({ status: "disconnected", account: null });
    expect((await store.list()).map((r) => r.id)).toEqual(["b", "a"]);
    await store.delete("b");
    expect(await store.get("b")).toBeUndefined();
  });

  it("keeps its DDL identical to the @psyche/db migration", () => {
    const db = readFileSync(
      new URL("../../../db/migrations/202610241000_connectors_init.sql", import.meta.url),
      "utf8",
    );
    expect(connectorsMigrationSql()).toBe(db);
  });
});
