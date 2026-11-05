import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@psyche/db";
import type { NodeClient } from "@psyche/protocol";
import { defaultSourcesConfig } from "@psyche/search";
import { DerivedKeyStore, isPlainSqlite } from "@psyche/vault";
import { afterEach, describe, expect, it } from "vitest";
import { DeferredOpen } from "../src/compose/deferred-open.ts";
import { composeSearch } from "../src/compose/search.ts";
import { resolveSearchKey, SEARCH_ENCRYPT_SETTING } from "../src/compose/search-db.ts";
import { memorySourceDeps } from "../src/compose/search-memory.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "psyche-deferred-"));
  dirs.push(d);
  return d;
};
const stops: Array<() => unknown> = [];
/** Run after every part stopped: databases close before their folder goes (Windows cannot delete an open file). */
const closeLast: Array<() => unknown> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const c of closeLast.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const wait = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
};

describe("DeferredOpen", () => {
  it("retries until the provider has a key, then opens once", async () => {
    let calls = 0;
    const opened: string[] = [];
    const d = new DeferredOpen<string>({
      provider: async () => {
        calls += 1;
        if (calls < 3) return undefined;
        return Buffer.from("k");
      },
      open: (k) => {
        opened.push(k.toString());
        return "ok";
      },
      retryMs: 5,
    });
    expect(d.value).toBeUndefined();
    d.start();
    d.start();
    await wait(() => d.value !== undefined);
    expect(opened).toEqual(["k"]);
    expect(calls).toBe(3);
  });

  it("treats a throwing provider as not ready and keeps the reason; stop ends it", async () => {
    let calls = 0;
    const d = new DeferredOpen<string>({
      provider: async () => {
        calls += 1;
        throw new Error("no helper");
      },
      open: () => "never",
      retryMs: 5,
    });
    d.start();
    await wait(() => calls >= 2);
    expect(d.reason).toBe("no helper");
    d.stop();
    const seen = calls;
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(seen);
    expect(d.value).toBeUndefined();
  });
});

/** A fake Mac helper: keychain items in a map; absent until `connect`. */
function fakeHelper() {
  const items = new Map<string, string>();
  let connected = false;
  const client = {
    nodeId: "helper",
    async capabilities() {
      if (!connected) throw new Error("no keychain helper is connected");
      return ["keychain.store", "keychain.retrieve", "keychain.delete_item", "keychain.status"].map(
        (name) => ({ name }),
      );
    },
    async invoke(cap: string, p: { name?: string; value?: string; requireAuth?: boolean }) {
      if (!connected) return { ok: false, error: { code: "unavailable" } };
      if (cap === "keychain.status")
        return { ok: true, result: { dataProtectionKeychain: "available", accessGroup: null } };
      if (cap === "keychain.store") {
        expect(p.requireAuth).toBe(false);
        items.set(String(p.name), String(p.value));
        return { ok: true, result: {} };
      }
      if (cap === "keychain.retrieve") {
        const v = items.get(String(p.name));
        return v === undefined
          ? { ok: false, error: { code: "not_found" } }
          : { ok: true, result: { value: v } };
      }
      return { ok: true, result: {} };
    },
  } as unknown as NodeClient;
  return { client, items, connect: () => (connected = true) };
}

function fixture(encrypt: boolean) {
  const home = tmp();
  const db = openDb(join(home, "psyche.sqlite"));
  closeLast.push(() => db.close());
  if (encrypt) db.sqlite.prepare("SELECT 1").get();
  return { home, db };
}

describe("composeSearch with a key from the Mac helper", () => {
  const baseDeps = (f: ReturnType<typeof fixture>, extra: object) =>
    ({
      db: f.db,
      home: f.home,
      memory: { search: async () => [] },
      tasks: { get: async () => undefined, actions: async () => [] },
      now: () => Date.UTC(2026, 10, 2),
      librarySyncMs: 0,
      backfillPauseMs: 0,
      ...extra,
    }) as never;
  const fakeGateway = () => ({ bus: { publish() {}, subscribe: () => () => {} } }) as never;

  it("derives the pending state from the keychain slot and the key from the helper item", async () => {
    const f = fixture(true);
    const { setSetting } = await import("@psyche/db");
    setSetting(f.db, SEARCH_ENCRYPT_SETTING, true);
    const helper = fakeHelper();
    const derived = new DerivedKeyStore(helper.client);
    const r = await resolveSearchKey({
      db: f.db,
      keyFile: join(f.home, "k.json"),
      wrapper: {} as never,
      slot: "keychain",
      derived,
    });
    expect(r.key).toBeUndefined();
    expect(r.status.state).toBe("pending");
    expect(await r.pending?.()).toBeUndefined();
    helper.connect();
    const key = await r.pending?.();
    expect(key).toHaveLength(32);
    expect(helper.items.size).toBe(1);
    expect((await r.pending?.())?.equals(key as Buffer)).toBe(true);
  });

  it("is empty and pending until the helper connects, then opens an encrypted index", async () => {
    const f = fixture(true);
    const helper = fakeHelper();
    const derived = new DerivedKeyStore(helper.client);
    const search = composeSearch(
      baseDeps(f, {
        encryption: {
          status: { state: "pending" },
          pending: async () =>
            (await derived.unavailableReason()) !== null
              ? undefined
              : (await derived.getOrCreate("search-index")).key,
        },
      }),
    );
    stops.push(() => search.stop?.());
    const gw = fakeGateway();
    search.start?.(gw);

    const before = (await search.handlers?.["search.query"]?.run(
      {} as never,
      { query: "lisbon" } as never,
    )) as {
      hits: unknown[];
    };
    expect(before.hits).toEqual([]);
    const st0 = (await search.status()) as { encryption?: { state: string } };
    expect(st0.encryption?.state).toBe("pending");
    // The index handle other parts hold answers empty instead of throwing.
    expect((await search.index.search({ q: "lisbon" })).hits).toEqual([]);

    helper.connect();
    await wait(
      async () =>
        ((await search.status()) as { encryption?: { state: string } }).encryption?.state === "on",
      8000,
    );
    await search.index.index({
      id: "d1",
      kind: "library",
      title: "Lisbon budget",
      text: "the secret lisbon budget",
      provenance: "owner",
      createdAt: 1,
    } as never);
    expect((await search.index.search({ q: "lisbon" })).hits.map((h) => h.id)).toEqual(["d1"]);
    const file = join(f.home, "state", "search.sqlite");
    expect(isPlainSqlite(readFileSync(file).subarray(0, 16))).toBe(false);
  }, 20000);

  it("rebuilds when the helper hands out a different key than the file was made with", async () => {
    const f = fixture(true);
    const keyA = Buffer.alloc(32, 1);
    const keyB = Buffer.alloc(32, 2);
    let key = keyA;
    const mk = () =>
      composeSearch(
        baseDeps(f, { encryption: { status: { state: "pending" }, pending: async () => key } }),
      );
    const a = mk();
    a.start?.(fakeGateway());
    await wait(
      async () =>
        ((await a.status()) as { encryption?: { state: string } }).encryption?.state === "on",
      8000,
    );
    await a.index.index({
      id: "d1",
      kind: "library",
      title: "old",
      text: "old",
      provenance: "owner",
      createdAt: 1,
    } as never);
    await a.stop?.();
    key = keyB;
    const b = mk();
    stops.push(() => b.stop?.());
    b.start?.(fakeGateway());
    await wait(
      async () =>
        ((await b.status()) as { encryption?: { state: string } }).encryption?.state === "on",
      8000,
    );
    expect(await b.index.count()).toBe(0);
  }, 30000);
});

describe("the Memory source and the index's real encryption state", () => {
  const memoryDeps = () =>
    memorySourceDeps({
      graph: () => undefined,
      config: () => defaultSourcesConfig(),
      agentMode: () => "accepted",
      memoryEncrypted: () => true,
    });
  const build = (encryption: object, memory: ReturnType<typeof memoryDeps>) => {
    const f = fixture(true);
    const search = composeSearch({
      db: f.db,
      home: f.home,
      memory: { search: async () => [] },
      tasks: { get: async () => undefined, actions: async () => [] },
      now: () => Date.UTC(2026, 10, 2),
      librarySyncMs: 0,
      backfillPauseMs: 0,
      sources: {
        apple: {
          call: () => undefined,
          helper: () => undefined,
          ownAddresses: () => [],
          now: () => 0,
        },
        memory,
      },
      encryption,
    } as never);
    stops.push(() => search.stop?.());
    return search;
  };

  it("stays blocked when the switch is on but the key was unavailable (the index is plain)", () => {
    const memory = memoryDeps();
    build({ status: { state: "unavailable", reason: "the vault slot would not open" } }, memory);
    expect(memory.blocked?.()).toMatch(/Turn on search index encryption first/);
  });

  it("is let through when the index really is encrypted", () => {
    const memory = memoryDeps();
    build({ key: Buffer.alloc(32, 7), status: { state: "on" } }, memory);
    expect(memory.blocked?.()).toBeUndefined();
  });

  it("is let through once a pending index (key from the helper) has opened encrypted", async () => {
    const memory = memoryDeps();
    const search = build(
      { status: { state: "pending" }, pending: async () => Buffer.alloc(32, 9) },
      memory,
    );
    search.start?.({ bus: { publish() {}, subscribe: () => () => {} } } as never);
    await wait(
      async () =>
        ((await search.status()) as { encryption?: { state: string } }).encryption?.state === "on",
      8000,
    );
    expect(memory.blocked?.()).toBeUndefined();
  }, 20000);
});
