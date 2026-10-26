import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, setSetting } from "@psyche/db";
import { TeachingStore } from "@psyche/memory";
import { FakeClock, FakeModelProvider } from "@psyche/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposedGateway, composeGateway } from "../src/compose/index.ts";
import { teachingSettings } from "../src/compose/teaching.ts";
import { isWeeklyCardAutomation, withWeeklyCard } from "../src/compose/weekly-card.ts";
import { silentLogger } from "../src/log.ts";

let home = "";
let composed: ComposedGateway | null = null;
afterEach(async () => {
  await composed?.stop("test");
  composed = null;
  if (home) rmSync(home, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-25T18:00:00Z"); // a Sunday

describe("the weekly What I learned post (#681)", () => {
  it("is scheduled Sunday 18:00, posts the card to the Feed, and stays quiet when off or empty", async () => {
    home = mkdtempSync(join(tmpdir(), "psyche-weekly-"));
    const clock = new FakeClock(NOW);
    composed = await composeGateway({
      env: {},
      logger: silentLogger,
      retentionIntervalMs: 0,
      background: false,
      timeZone: "UTC",
      clock,
      config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
      model: { provider: new FakeModelProvider(), model: "fake/model" },
    });
    const c = composed;
    const automation = (await c.scheduler.list()).find(isWeeklyCardAutomation);
    expect(automation).toMatchObject({ schedule: "0 18 * * 0", title: "What I learned this week" });

    const store = new TeachingStore({ sqlite: c.db.sqlite, clock });
    const inner = { launch: vi.fn() };
    const launcher = withWeeklyCard(inner as never, {
      store,
      memory: c.memory,
      clock,
      enabled: () =>
        teachingSettings(c.db).enabled && getSetting(c.db, "teaching.weeklyCard")?.value !== false,
      post: (card) => c.proactive.feed.postGrowth(card),
    });
    const run = async () =>
      (
        await launcher.launch({
          automation,
          run: { id: "r" },
          threadId: "t",
          prompt: "",
          lightContext: true,
        } as never)
      ).result;

    expect(await run()).toMatchObject({ status: "no_reply", summary: "nothing to say this week" });
    store.insertLesson({
      kind: "style",
      origin: "stated",
      statement: "Replies to Jane are short",
      scope: { recipient: "jane@example.com" },
      destination: { type: "file", path: "USER.md", section: "Preferences", lineId: "ls_x" },
      previous: null,
      value: "Replies to Jane are short",
      sources: [],
      confidence: 0.9,
      status: "active",
    });
    setSetting(c.db, "teaching.weeklyCard", false);
    expect(await run()).toMatchObject({ summary: "weekly card is off" });
    setSetting(c.db, "teaching.weeklyCard", true);
    expect(await run()).toMatchObject({
      status: "no_reply",
      summary: expect.stringMatching(/^posted 1 items/),
    });
    expect(inner.launch).not.toHaveBeenCalled();

    const { posts } = await c.proactive.feed.list();
    const post = posts.find((p) => p.growth !== undefined);
    expect(post).toMatchObject({
      title: "What I learned this week",
      growth: {
        weekOf: "2026-10-19",
        items: [{ type: "lesson", statement: "Replies to Jane are short" }],
      },
    });
  });
});
