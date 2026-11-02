import { describe, expect, it } from "vitest";
import {
  type BrowserPage,
  browserAdapter,
  chunkTurns,
  defaultSourcesConfig,
  pageItem,
  type RecordingRef,
  SourceIndexer,
  type SourcesConfig,
  splitTurns,
  transcriptItems,
  transcriptsAdapter,
} from "../src/index.ts";
import { DAY, NOW, setup } from "./helpers.ts";

const BODY = "A long enough article about the Lisbon rental market. ".repeat(8);
const page = (over: Partial<BrowserPage> = {}): BrowserPage => ({
  url: "https://www.example.com/articles/lisbon?utm_source=x&token=secret#top",
  title: "Lisbon rents",
  text: BODY,
  readAt: NOW,
  partition: "profile",
  ...over,
});

describe("pageItem", () => {
  it("strips the query and fragment, is untrusted, and tags the host", () => {
    const item = pageItem(page());
    expect(item?.provenance).toBe("untrusted");
    expect(item?.text.startsWith("https://www.example.com/articles/lisbon\n")).toBe(true);
    expect(item?.text).not.toContain("secret");
    expect(item?.from).toBe("example.com");
  });
  it("skips clean tabs, incognito chats, sensitive and local pages, and short text", () => {
    expect(pageItem(page({ partition: "clean" }))).toBeUndefined();
    expect(pageItem(page({ incognito: true }))).toBeUndefined();
    expect(pageItem(page({ url: "https://bank.example/login" }))).toBeUndefined();
    expect(pageItem(page({ url: "https://shop.example/checkout/step2" }))).toBeUndefined();
    expect(pageItem(page({ url: "http://localhost:3000/docs" }))).toBeUndefined();
    expect(pageItem(page({ url: "http://192.168.1.4/admin" }))).toBeUndefined();
    expect(pageItem(page({ url: "file:///etc/passwd" }))).toBeUndefined();
    expect(pageItem(page({ text: "too short" }))).toBeUndefined();
  });
});

describe("browser source", () => {
  function harness(enabled: boolean) {
    const { index } = setup();
    let config: SourcesConfig = defaultSourcesConfig();
    config.sources.browser.enabled = enabled;
    let now = NOW;
    const adapter = browserAdapter({ enabled: () => config.sources.browser.enabled });
    const indexer = new SourceIndexer(index, [adapter], {
      config: () => config,
      now: () => now,
      pauseMs: 0,
    });
    return {
      index,
      adapter,
      indexer,
      advance: (ms: number) => {
        now += ms;
      },
      set: (on: boolean) => {
        config = {
          ...config,
          sources: { ...config.sources, browser: { ...config.sources.browser, enabled: on } },
        };
      },
      ids: () =>
        (index.db.prepare("SELECT id FROM search_docs").all() as { id: string }[]).map((r) => r.id),
    };
  }

  it("holds nothing while off", async () => {
    const h = harness(false);
    expect(h.adapter.offer(page())).toBe(false);
    expect(h.adapter.queued).toBe(0);
    await h.indexer.tick();
    expect(h.ids()).toEqual([]);
  });

  it("indexes an offered page as untrusted and finds it", async () => {
    const h = harness(true);
    expect(h.adapter.offer(page())).toBe(true);
    await h.indexer.tick();
    const res = await h.index.search({ q: "lisbon rental" });
    expect(res.hits[0]?.title).toBe("Lisbon rents");
    expect(res.hits[0]?.provenance).toBe("untrusted");
    expect(h.indexer.status().sources.find((s) => s.id === "browser")?.items).toBe(1);
  });

  it("removes pages after 90 days and everything when switched off", async () => {
    const h = harness(true);
    h.adapter.offer(page());
    await h.indexer.tick();
    expect(h.ids()).toHaveLength(1);
    h.advance(91 * DAY);
    await h.indexer.sweep("browser");
    expect(h.ids()).toEqual([]);
    h.advance(1);
    h.adapter.offer(page({ readAt: NOW + 91 * DAY }));
    await h.indexer.tick();
    expect(h.ids()).toHaveLength(1);
    h.set(false);
    await h.indexer.applyConfig();
    expect(h.ids()).toEqual([]);
  });
});

describe("transcripts", () => {
  const text = [
    "Maya [00:03]: Let's talk about the Lisbon budget.",
    "Maya: It is higher than last year.",
    "Daniel [01:10]: I will check the flights.",
    "continued thought on the same turn",
  ].join("\n");

  it("splits speaker turns, merges the same speaker and keeps timestamps", () => {
    const turns = splitTurns(text);
    expect(turns.map((t) => t.speaker)).toEqual(["Maya", "Maya", "Daniel"]);
    expect(turns[0]?.at).toBe("00:03");
    expect(turns[2]?.text).toContain("continued thought");
    const chunks = chunkTurns(turns);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toContain("higher than last year");
  });

  it("chunks unlabeled long text and does not mistake prose for a speaker", () => {
    expect(splitTurns("Note to self: buy milk")[0]?.speaker).toBeUndefined();
    expect(splitTurns("Speaker 2: hello")[0]?.speaker).toBe("Speaker 2");
    expect(
      splitTurns("This is a sentence: with a long lead in clause about many things")[0]?.speaker,
    ).toBeUndefined();
    const long = "word. ".repeat(600);
    const chunks = chunkTurns(splitTurns(long));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 1500)).toBe(true);
  });

  const rec = (over: Partial<RecordingRef> = {}): RecordingRef => ({
    id: "lib-1",
    name: "Budget call",
    createdAt: NOW - DAY,
    tags: ["meeting"],
    provenance: "untrusted",
    text,
    ...over,
  });

  it("indexes child docs under the recording with speaker as sender and its provenance", async () => {
    const { index } = setup();
    const config = defaultSourcesConfig();
    config.sources.transcripts.enabled = true;
    const recs = [rec()];
    const indexer = new SourceIndexer(
      index,
      [
        transcriptsAdapter({
          recordings: async (since) => recs.filter((r) => r.createdAt >= since),
        }),
      ],
      { config: () => config, now: () => NOW, pauseMs: 0 },
    );
    await indexer.tick();
    const rows = index.db
      .prepare("SELECT id, parent_id, sender, provenance, tags FROM search_docs ORDER BY id")
      .all() as {
      id: string;
      parent_id: string;
      sender: string;
      provenance: string;
      tags: string;
    }[];
    expect(rows.map((r) => r.id)).toEqual(["transcripts:lib-1#0", "transcripts:lib-1#1"]);
    expect(rows.every((r) => r.parent_id === "lib-1" && r.provenance === "untrusted")).toBe(true);
    expect(rows.map((r) => r.sender)).toEqual(["Maya", "Daniel"]);
    expect(JSON.parse(rows[0]?.tags ?? "[]")).toContain("transcript");
    const res = await index.search({ q: "from:daniel flights" });
    expect(res.hits[0]?.id).toBe("transcripts:lib-1#1");
    // A recording removed from the Library disappears on the sweep.
    recs.length = 0;
    expect(await indexer.sweep("transcripts")).toBe(2);
  });

  it("items carry timestamps in the title", () => {
    expect(transcriptItems(rec())[0]?.title).toBe("Budget call · Maya · 00:03");
  });
});
