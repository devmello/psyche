import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        (r) => r.id.replace(`files:${root}/`, ""),
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
    expect(st.sources.map((s) => s.id)).toEqual([
      "mail",
      "messages",
      "notes",
      "calendar",
      "reminders",
      "files",
    ]);
    expect(st.sources.every((s) => !s.enabled && s.state === "off" && s.items === 0)).toBe(true);
    expect(st.sources.every((s) => s.processing === "cloud")).toBe(true);
    expect(st.sources.filter((s) => !s.agent).map((s) => s.id)).toEqual(["messages"]);
  });

  it("toggles a source, keeps the processing model and exclusions, and rebuilds", async () => {
    const owner = await start();
    let st = await owner.call<SearchSourcesStatus>(
      "search.sources.configure",
      {
        source: "messages",
        enabled: true,
        processing: "local",
        exclude: { contacts: ["mum@example.com"] },
      },
      ik(),
    );
    const m = st.sources.find((s) => s.id === "messages");
    // No Mac helper in this test: enabled, but it says why nothing is read.
    expect(m).toMatchObject({
      enabled: true,
      processing: "local",
      agent: false,
      state: "unavailable",
    });
    expect(st.exclude.contacts).toEqual(["mum@example.com"]);
    st = await owner.call<SearchSourcesStatus>(
      "search.sources.configure",
      { source: "messages", agent: true },
      ik(),
    );
    expect(st.sources.find((s) => s.id === "messages")?.agent).toBe(true);
    st = await owner.call<SearchSourcesStatus>(
      "search.sources.rebuild",
      { source: "messages" },
      ik(),
    );
    expect(st.sources.find((s) => s.id === "messages")?.enabled).toBe(true);
    st = await owner.call<SearchSourcesStatus>(
      "search.sources.configure",
      { source: "messages", enabled: false },
      ik(),
    );
    expect(st.sources.find((s) => s.id === "messages")).toMatchObject({
      enabled: false,
      processing: "local",
      state: "off",
    });
    expect(st.exclude.contacts).toEqual(["mum@example.com"]);
  });
});
