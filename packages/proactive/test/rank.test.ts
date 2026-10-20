import { describe, expect, it } from "vitest";
import {
  checkCitations,
  cluster,
  createEmbedder,
  dedupe,
  exclusions,
  extractJson,
  hackerNewsSource,
  ledgerTopics,
  normalizeUrl,
  parseFeedXml,
  parseLedger,
  pickExploration,
  scoreClusters,
  seededShuffle,
  seedFrom,
} from "../src/index.ts";
import { ATOM, fixtureFetch, HN, INTERESTS, RSS } from "./fixtures/feeds.ts";

const NOW = Date.parse("2026-10-19T09:00:00Z");

describe("sources", () => {
  it("parses RSS and Atom as plain, capped, entity-decoded text and skips items without a link", () => {
    const rss = parseFeedXml(RSS, "rss:robotreport.example");
    expect(rss.map((c) => c.url)).toEqual([
      "https://robotreport.example/gripper",
      "https://evil.example/injection",
      "https://gossip.example/robot-wedding",
    ]);
    expect(rss[0]).toMatchObject({
      title: "New gripper learns from 10 demos & generalizes",
      summary: "A manipulation lab shows a gripper that generalizes from ten demonstrations.",
      host: "robotreport.example",
      publishedAt: "2026-10-19T06:00:00.000Z",
      kind: "news",
    });
    const atom = parseFeedXml(ATOM, "arxiv");
    expect(atom.map((c) => c.kind)).toEqual(["paper", "paper", "paper"]);
    expect(atom[0]?.url).toBe("https://arxiv.example/abs/2610.00001");
  });

  it("Hacker News hits become candidates; a hit without a url points at the HN item", async () => {
    const { fetch } = fixtureFetch();
    const got = await hackerNewsSource().fetch({ fetch, now: NOW, topics: [] });
    expect(got.map((c) => c.url)).toEqual([
      "https://bench.example/manipulation",
      "https://robotreport.example/gripper",
      "https://news.ycombinator.com/item?id=3",
    ]);
    expect(JSON.parse(HN).hits).toHaveLength(3);
  });

  it("normalizes urls (tracking params, fragments, www, trailing slash)", () => {
    expect(normalizeUrl("https://WWW.Example.com/a/?utm_source=x&id=1#frag")).toBe(
      "https://example.com/a/?id=1",
    );
    expect(normalizeUrl("https://example.com/a/")).toBe("https://example.com/a");
  });
});

describe("ranking", () => {
  async function pool() {
    const embed = createEmbedder(undefined);
    const candidates = dedupe([
      ...parseFeedXml(RSS, "rss:robotreport.example"),
      ...parseFeedXml(ATOM, "arxiv"),
      ...(await hackerNewsSource().fetch({ fetch: fixtureFetch().fetch, now: NOW, topics: [] })),
    ]);
    const ledger = parseLedger(INTERESTS);
    const topics = ledgerTopics(ledger);
    const clusters = await cluster(candidates, embed);
    const scored = scoreClusters(clusters, {
      topics,
      topicVectors: await embed(topics.map((t) => t.topic)),
      excluded: exclusions(ledger),
      excludedVectors: await embed(exclusions(ledger)),
      hiddenHosts: [],
      now: NOW,
    });
    return { candidates, clusters, scored, topics };
  }

  it("dedupes by url and clusters the same story from two sources", async () => {
    const { candidates, clusters } = await pool();
    // The gripper story appears in the RSS feed and on HN with the same url → one candidate.
    expect(candidates.filter((c) => c.url === "https://robotreport.example/gripper")).toHaveLength(
      1,
    );
    // The arXiv paper and the gripper story share a title shape and wording → one cluster or two,
    // but every cluster carries its members and a centroid.
    expect(clusters.every((k) => k.members.length >= 1 && k.vector.length > 0)).toBe(true);
  });

  it("scores recall × recency with reasons; excluded topics drop out; order is deterministic", async () => {
    const { scored } = await pool();
    const titles = scored.map((k) => k.members[0]?.title);
    expect(titles).not.toContain("Celebrity robot wedding stuns fans");
    expect(scored[0]?.reasons[0]).toMatch(/^interest: robotics manipulation /);
    expect(scored.every((k) => k.reasons.some((r) => /^recency|^undated/.test(r)))).toBe(true);
    const again = await pool();
    expect(again.scored.map((k) => k.id)).toEqual(scored.map((k) => k.id));
  });

  it("exploration picks the freshest low-recall cluster; the shuffle is seeded", async () => {
    const { scored } = await pool();
    const chosen = new Set(scored.slice(0, 2).map((k) => k.id));
    const ex = pickExploration(scored, chosen, 1);
    expect(ex).toHaveLength(1);
    expect(ex[0]?.recall).toBeLessThan(0.3);
    expect(chosen.has(ex[0]?.id ?? "")).toBe(false);
    const a = seededShuffle([1, 2, 3, 4, 5, 6], seedFrom("batch-1"));
    expect(seededShuffle([1, 2, 3, 4, 5, 6], seedFrom("batch-1"))).toEqual(a);
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seededShuffle([1, 2, 3, 4, 5, 6], seedFrom("batch-2"))).not.toEqual(a);
  });
});

describe("model output parsing", () => {
  it("extracts JSON from prose and fences; rejects posts without valid citations", () => {
    expect(extractJson("Sure! ```json\n[3, 1, 2]\n```")).toEqual([3, 1, 2]);
    expect(extractJson('{"title": "t", "body": "b [1]"} trailing')).toEqual({
      title: "t",
      body: "b [1]",
    });
    expect(extractJson("no json here")).toBeUndefined();
    expect(checkCitations("claims without sources", 2)).toBe("no citations");
    expect(checkCitations("a claim [3]", 2)).toBe("citation [3] names no source");
    expect(checkCitations("a claim [1] and another [2]", 2)).toBeUndefined();
  });
});
