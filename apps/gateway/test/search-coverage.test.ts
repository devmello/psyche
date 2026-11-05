import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { setSetting } from "@psyche/db";
import type { SearchSourcesStatus } from "@psyche/protocol";
import {
  createSearchIndex,
  defaultSourcesConfig,
  filesAdapter,
  SourceIndexer,
} from "@psyche/search";
import { FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { filesSourceDeps, parsePower } from "../src/compose/search-files.ts";
import { MEMORY_AGENT_NONE, MEMORY_NEEDS_ENCRYPTED_INDEX } from "../src/compose/search-memory.ts";
import { silentLogger } from "../src/log.ts";
import { adminClient, ik, type TestClient } from "./helpers.ts";

/** Roadmap §2: local sources in the main index. Fixtures only; no real mail, messages or files. */

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "psyche-cov-"));
  dirs.push(d);
  return d;
};
let composed: ComposedGateway | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await composed?.stop("test");
  composed = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("files source", () => {
  function setup() {
    const root = tmp();
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "Downloads"));
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, "Private"));
    writeFileSync(join(root, "docs", "trip.md"), "# Lisbon trip\nFlight TP 214 leaves at 7am");
    writeFileSync(join(root, "docs", "tool.ts"), "export const answer = 42; // quarterly forecast");
    writeFileSync(join(root, "Downloads", "invoice.txt"), "Pay ACME 400 euros");
    writeFileSync(join(root, "node_modules", "junk.js"), "should never be indexed");
    writeFileSync(join(root, ".secret.txt"), "hidden");
    writeFileSync(join(root, "Private", "diary.txt"), "dear diary");
    writeFileSync(join(root, "docs", "photo.bin"), "not a known type");
    symlinkSync(join(root, "docs", "trip.md"), join(root, "docs", "link.md"));
    const index = createSearchIndex();
    let folders = [{ path: root, mode: "ro" as const }];
    const adapter = filesAdapter(filesSourceDeps({ folders: () => folders }));
    const config = defaultSourcesConfig();
    config.sources.files.enabled = true;
    const indexer = new SourceIndexer(index, [adapter], { config: () => config, pauseMs: 0 });
    const ids = () =>
      (index.db.prepare("SELECT id FROM search_docs ORDER BY id").all() as { id: string }[]).map(
        // Document ids hold the native path; compare them with "/" on every OS.
        (r) => r.id.replace(`files:${root}${sep}`, "").replaceAll(sep, "/"),
      );
    return {
      root,
      index,
      adapter,
      indexer,
      config,
      ids,
      setFolders: (f: typeof folders) => (folders = f),
    };
  }

  it("indexes text, Markdown and code in granted folders; skips hidden, links, dependencies", async () => {
    const t = setup();
    await t.indexer.tick();
    expect(t.ids()).toEqual([
      "Downloads/invoice.txt",
      "Private/diary.txt",
      "docs/tool.ts",
      "docs/trip.md",
    ]);
    const q = await t.index.search({ q: "Lisbon flight" });
    expect(q.hits[0]?.id).toContain("trip.md");
    const prov = (name: string) =>
      (
        t.index.db
          .prepare("SELECT provenance FROM search_docs WHERE id LIKE ?")
          .get(`%${name}`) as {
          provenance: string;
        }
      ).provenance;
    expect(prov("trip.md")).toBe("owner");
    expect(prov("invoice.txt")).toBe("untrusted");
  });

  it("follows changes, propagates deletions in the sweep, honours folder exclusion", async () => {
    const t = setup();
    await t.indexer.tick();
    writeFileSync(join(t.root, "docs", "new.md"), "brand new note about zebras");
    utimesSync(
      join(t.root, "docs", "new.md"),
      new Date(Date.now() + 5000),
      new Date(Date.now() + 5000),
    );
    t.adapter.invalidate();
    await t.indexer.tick();
    expect(t.ids()).toContain("docs/new.md");
    rmSync(join(t.root, "docs", "new.md"));
    expect(await t.indexer.sweep("files")).toBe(1);
    expect(t.ids()).not.toContain("docs/new.md");
    t.config.exclude.folders = [join(t.root, "Private")];
    await t.indexer.applyConfig();
    expect(t.ids()).not.toContain("Private/diary.txt");
  });

  it("is unavailable when no folder is granted, and a revoked grant empties the source on sweep", async () => {
    const t = setup();
    await t.indexer.tick();
    t.setFolders([]);
    expect(t.indexer.status().sources.find((s) => s.id === "files")?.state).toBe("unavailable");
    t.setFolders([{ path: join(t.root, "docs"), mode: "ro" }]);
    t.adapter.invalidate();
    await t.indexer.sweep("files");
    expect(t.ids().every((i) => i.startsWith("docs/"))).toBe(true);
  });
});

describe("power", () => {
  it("parses pmset output", () => {
    expect(parsePower("Now drawing from 'Battery Power'", " lowpowermode         1\n")).toEqual({
      onBattery: true,
      lowPower: true,
    });
    expect(parsePower("Now drawing from 'AC Power'", " lowpowermode 0")).toEqual({
      onBattery: false,
      lowPower: false,
    });
  });
});

/** The host decides which local sources exist (no Notes or Messages on Windows). */
const WINDOWS = process.platform === "win32";

describe("search.sources methods", () => {
  async function start() {
    const home = tmp();
    composed = await composeGateway({
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const owner = await adminClient(composed.gateway);
    clients.push(owner);
    return owner;
  }

  it("lists every source off by default, with nothing read", async () => {
    const owner = await start();
    const st = await owner.call<SearchSourcesStatus>("search.sources", {});
    // Notes and Messages are Mac apps: Windows lists no row for them.
    expect(st.sources.map((s) => s.id)).toEqual(
      [
        "mail",
        "messages",
        "notes",
        "calendar",
        "reminders",
        "contacts",
        "files",
        "browser",
        "transcripts",
        "memory",
      ].filter((id) => !WINDOWS || (id !== "messages" && id !== "notes")),
    );
    expect(st.sources.every((s) => !s.enabled && s.state === "off" && s.items === 0)).toBe(true);
    // Memory (its facts come from other sources' text) and Contacts ship with no summaries.
    expect(st.sources.filter((s) => s.processing !== "cloud").map((s) => s.id)).toEqual([
      "contacts",
      "memory",
    ]);
    // Messages, Contacts and Memory stay owner-only until the owner allows the agent to search them.
    expect(st.sources.filter((s) => !s.agent).map((s) => s.id)).toEqual(
      WINDOWS ? ["contacts", "memory"] : ["messages", "contacts", "memory"],
    );
  });

  it("toggles a source, keeps the processing model and exclusions, and rebuilds", async () => {
    const owner = await start();
    // Windows has no Messages source: Reminders (unavailable too, nothing connected) stands in.
    const SRC = WINDOWS ? "reminders" : "messages";
    let st = await owner.call<SearchSourcesStatus>(
      "search.sources.configure",
      {
        source: SRC,
        enabled: true,
        processing: "local",
        exclude: { contacts: ["mum@example.com"] },
      },
      ik(),
    );
    const m = st.sources.find((s) => s.id === SRC);
    // No Mac helper in this test: enabled, but it says why nothing is read.
    expect(m).toMatchObject({
      enabled: true,
      processing: "local",
      agent: WINDOWS,
      state: "unavailable",
    });
    expect(st.exclude.contacts).toEqual(["mum@example.com"]);
    st = await owner.call<SearchSourcesStatus>(
      "search.sources.configure",
      { source: SRC, agent: !WINDOWS },
      ik(),
    );
    expect(st.sources.find((s) => s.id === SRC)?.agent).toBe(!WINDOWS);
    // No Mac helper: a rebuild would empty Messages and could not fill it, so it is refused.
    const refused = await owner.request("search.sources.rebuild", { source: SRC }, ik());
    expect(refused).toMatchObject({ ok: false, error: { code: "unavailable", retryable: true } });
    expect(JSON.stringify(refused.error)).toMatch(
      WINDOWS ? /Reminders can't be read right now/ : /Messages can't be read right now/,
    );
    st = await owner.call<SearchSourcesStatus>("search.sources", {});
    expect(st.sources.find((s) => s.id === SRC)?.enabled).toBe(true);
    st = await owner.call<SearchSourcesStatus>(
      "search.sources.configure",
      { source: SRC, enabled: false },
      ik(),
    );
    expect(st.sources.find((s) => s.id === SRC)).toMatchObject({
      enabled: false,
      processing: "local",
      state: "off",
    });
    expect(st.exclude.contacts).toEqual(["mum@example.com"]);
  });

  it("Memory: switches on like the others, reads nothing while memory is off, and can be rebuilt", async () => {
    const owner = await start();
    let st = await owner.call<SearchSourcesStatus>(
      "search.sources.configure",
      { source: "memory", enabled: true },
      ik(),
    );
    expect(st.sources.find((s) => s.id === "memory")).toMatchObject({
      label: "Memory",
      enabled: true,
      agent: false,
    });
    // The people and projects memory is off in a new home: nothing to index, and it says it is read.
    for (let i = 0; i < 40; i++) {
      st = await owner.call<SearchSourcesStatus>("search.sources", {});
      if (st.sources.find((s) => s.id === "memory")?.state === "idle") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(st.sources.find((s) => s.id === "memory")).toMatchObject({ state: "idle", items: 0 });
    // These tests run on the machine's real power state: a laptop on battery would refuse.
    await owner.call("settings.set", { key: "search.runOnBattery", value: true }, ik());
    const rebuilt = await owner.request("search.sources.rebuild", { source: "memory" }, ik());
    expect(rebuilt.ok).toBe(true);
    // Switching it off again leaves the others as they were.
    st = await owner.call<SearchSourcesStatus>(
      "search.sources.configure",
      { source: "memory", enabled: false },
      ik(),
    );
    expect(st.sources.find((s) => s.id === "memory")?.state).toBe("off");
  });

  const waitFor = async <T>(read: () => Promise<T>, ok: (v: T) => boolean) => {
    let last = await read();
    for (let i = 0; i < 60 && !ok(last); i++) {
      await new Promise((r) => setTimeout(r, 100));
      last = await read();
    }
    return last;
  };

  it("Memory: the agent cannot be let search it while memory's agent access is none, and the Gateway keeps it off", async () => {
    const owner = await start();
    const status = () => owner.call<SearchSourcesStatus>("search.sources", {});
    const memory = (st: SearchSourcesStatus) => st.sources.find((s) => s.id === "memory");
    // Everything memory is off in a new home: no agent access.
    expect(memory(await status())?.cannotAgent).toBe(MEMORY_AGENT_NONE);
    const refused = await owner.request(
      "search.sources.configure",
      { source: "memory", enabled: true, agent: true },
      ik(),
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(JSON.stringify(refused.error)).toMatch(/agent access is set to none/);
    // Allowed once memory's own agent access is on.
    await owner.call(
      "settings.set",
      { key: "memory.everything", value: { enabled: true, agentAccess: "accepted" } },
      ik(),
    );
    expect(memory(await status())?.cannotAgent).toBeUndefined();
    let st = await owner.call<SearchSourcesStatus>(
      "search.sources.configure",
      { source: "memory", enabled: true, agent: true },
      ik(),
    );
    expect(memory(st)?.agent).toBe(true);
    // Memory's agent access goes back to none: Search follows, whatever was ticked.
    await owner.call(
      "settings.set",
      { key: "memory.everything", value: { enabled: true, agentAccess: "none" } },
      ik(),
    );
    st = await waitFor(status, (v) => memory(v)?.agent === false);
    expect(memory(st)).toMatchObject({ agent: false, cannotAgent: MEMORY_AGENT_NONE });
  });

  it("Memory: cannot be switched on while memory is encrypted and the search index is not", async () => {
    const owner = await start();
    const db = (composed as ComposedGateway).gateway.context.db;
    setSetting(db, "memory.encrypt", true);
    const st = await owner.call<SearchSourcesStatus>("search.sources", {});
    expect(st.sources.find((s) => s.id === "memory")?.cannotEnable).toBe(
      MEMORY_NEEDS_ENCRYPTED_INDEX,
    );
    const refused = await owner.request(
      "search.sources.configure",
      { source: "memory", enabled: true },
      ik(),
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(JSON.stringify(refused.error)).toMatch(/Turn on search index encryption first/);
    // The switch for the index being on is not the index being encrypted (its key can be
    // unavailable, and then it stays plain): still refused, because this index is plain.
    setSetting(db, "search.encrypt", true);
    const still = await owner.request(
      "search.sources.configure",
      { source: "memory", enabled: true },
      ik(),
    );
    expect(still).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    // Memory not encrypted: fine.
    setSetting(db, "memory.encrypt", false);
    const ok = await owner.call<SearchSourcesStatus>(
      "search.sources.configure",
      { source: "memory", enabled: true },
      ik(),
    );
    expect(ok.sources.find((s) => s.id === "memory")?.enabled).toBe(true);
  });

  it("Memory: a change in memory (a person hidden, a fact retracted) reaches the index soon, not at the next timer tick", {
    timeout: 30_000,
  }, async () => {
    const owner = await start();
    const status = () => owner.call<SearchSourcesStatus>("search.sources", {});
    const items = (st: SearchSourcesStatus) =>
      st.sources.find((s) => s.id === "memory")?.items ?? 0;
    await owner.call("settings.set", { key: "memory.graph", value: { enabled: true } }, ik());
    await owner.call("search.sources.configure", { source: "memory", enabled: true }, ik());
    const made = await owner.call<{ entity: { id: string } }>(
      "memory.entities.create",
      { kind: "topic", name: "Sourdough starter" },
      ik(),
    );
    // The new entity is read without waiting for the timer (the test Gateway has none).
    expect(items(await waitFor(status, (v) => items(v) === 1))).toBe(1);
    await owner.call("memory.entities.update", { id: made.entity.id, hidden: true }, ik());
    expect(items(await waitFor(status, (v) => items(v) === 0))).toBe(0);
    // Memory switched off: nothing stays.
    await owner.call("memory.entities.update", { id: made.entity.id, hidden: false }, ik());
    expect(items(await waitFor(status, (v) => items(v) === 1))).toBe(1);
    await owner.call("settings.set", { key: "memory.graph", value: { enabled: false } }, ik());
    expect(items(await waitFor(status, (v) => items(v) === 0))).toBe(0);
  });

  it("Rebuild: refused for a source that is off, answers indexing from zero when it runs", async () => {
    const owner = await start();
    const off = await owner.request("search.sources.rebuild", { source: "transcripts" }, ik());
    expect(off).toMatchObject({
      ok: false,
      error: { code: "invalid_params", message: "Turn Transcripts on first." },
    });
    await owner.call("search.sources.configure", { source: "transcripts", enabled: true }, ik());
    // These tests run on the machine's real power state: a laptop on battery would refuse.
    await owner.call("settings.set", { key: "search.runOnBattery", value: true }, ik());
    const st = await owner.call<SearchSourcesStatus>(
      "search.sources.rebuild",
      { source: "transcripts" },
      ik(),
    );
    // Reading starts in the background; the reply says so instead of looking like nothing happened.
    expect(st.sources.find((s) => s.id === "transcripts")).toMatchObject({
      enabled: true,
      state: "indexing",
      items: 0,
    });
    // It finishes by itself (there are no recordings to read).
    for (let i = 0; i < 40; i++) {
      const now = await owner.call<SearchSourcesStatus>("search.sources", {});
      if (now.sources.find((s) => s.id === "transcripts")?.state === "idle") return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the rebuilt source never finished");
  });
});
