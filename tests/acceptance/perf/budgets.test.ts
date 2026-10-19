import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpBridgeDriver, FsQuarantineWriter } from "@psyche/browser";
import { type FxNode, type FxSite, MockBrowser, MockDesktop } from "@psyche/browser/testing";
import { openDb } from "@psyche/db";
import { SqliteMemoryStore } from "@psyche/memory";
import { FakeClock } from "@psyche/testing";
import { afterAll, describe, expect, it } from "vitest";
import { type Skeleton, startSkeleton } from "../../integration/walking-skeleton/harness.ts";
import {
  MAIN,
  ScriptedModel,
  say,
  UTILITY,
} from "../../integration/walking-skeleton/scripted-model.ts";
import { median, writeReport } from "../src/report.ts";

/**
 * Performance budgets (docs/03 "Cross-cutting acceptance criteria"): cold start to first token
 * under 3 s with a hosted model, browser snapshot under 300 ms for typical pages, memory search
 * under 100 ms. Measured here with the scripted provider, so the first-token figure is the
 * Gateway's own overhead (boot, pairing, loop) without model latency; the hosted-model number
 * comes from the live gates (live/scenarios.live.test.ts) and is "needs live model" until then.
 *
 * CI runners are slow and shared, so the asserted budgets are the documented ones times a CI
 * factor; the scorecard quotes the local medians from out/acceptance/perf.json.
 */

const CI_FACTOR = process.env.CI ? 3 : 1;
const BUDGET = {
  coldStartToFirstTokenMs: 3_000,
  browserSnapshotMs: 300,
  memorySearchMs: 100,
};

const timings: Record<string, number> = {};
let sk: Skeleton | undefined;
const dirs: string[] = [];

afterAll(async () => {
  await sk?.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  writeReport("perf", {
    machine: `${process.platform}/${process.arch} node ${process.versions.node}${process.env.CI ? " (CI)" : ""}`,
    budgets: BUDGET,
    ciFactor: CI_FACTOR,
    timings,
  });
});

const temp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

describe("Gateway cold start and first token (scripted provider)", () => {
  it("boots the composed Gateway, pairs, and streams the first delta inside the budget", async () => {
    const model = new ScriptedModel();
    const t0 = performance.now();
    sk = await startSkeleton({ model: { provider: model, model: MAIN, utilityModel: UTILITY } });
    const bootMs = performance.now() - t0;
    const c = sk.client;
    const { thread } = await c.call<{ thread: { id: string } }>(
      "threads.create",
      { kind: "main" },
      true,
    );
    const firstDelta: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      model.chat.enqueue(say(`Reply ${i + 1}: hello from the scripted model.`));
      const from = c.mark;
      const sentAt = performance.now();
      await c.call("chat.send", { threadId: thread.id, content: `ping ${i + 1}` }, true);
      await c.event("chat.delta", () => true, from, 30_000);
      firstDelta.push(performance.now() - sentAt);
      await c.event<{ run: { status: string } }>(
        "run.updated",
        (p) => ["done", "failed", "cancelled"].includes(p.run.status),
        from,
        30_000,
      );
    }
    timings.gatewayBootMs = Math.round(bootMs);
    timings.firstDeltaMs = Math.round(median(firstDelta));
    timings.coldStartToFirstDeltaMs = Math.round(bootMs + (firstDelta[0] as number));
    expect(timings.coldStartToFirstDeltaMs).toBeLessThan(
      BUDGET.coldStartToFirstTokenMs * CI_FACTOR,
    );
  });
});

/** A "typical" article page: ~400 nodes of headings, paragraphs, links, lists and a form. */
function typicalPage(): FxSite {
  const body: FxNode[] = [{ kind: "heading", level: 1, text: "Cold-climate heat pumps" }];
  for (let s = 0; s < 40; s += 1) {
    body.push(
      { kind: "heading", level: 2, text: `Section ${s + 1}: field results` },
      { kind: "text", text: `Paragraph ${s + 1}a. Measured COP at -25 °C stayed above 1.8.` },
      { kind: "text", text: `Paragraph ${s + 1}b. Installed cost ranged from $14k to $22k.` },
      { kind: "link", text: `Study ${s + 1}`, href: `/studies/${s + 1}` },
      {
        kind: "list",
        items: [
          { kind: "text", text: `Item ${s + 1}.1` },
          { kind: "text", text: `Item ${s + 1}.2` },
          { kind: "link", text: `Rebate ${s + 1}`, href: `/rebates/${s + 1}` },
        ],
      },
    );
  }
  body.push({
    kind: "form",
    action: "/search",
    method: "get",
    children: [
      { kind: "input", label: "Search the guide", name: "q", type: "search" },
      { kind: "button", text: "Search", type: "submit" },
    ],
  });
  return {
    pages: { "a/guide": { title: "Cold-climate heat pumps: guide", body } },
    redirects: {},
    downloads: {},
  };
}

describe("browser snapshot over the CDP bridge (mock desktop)", () => {
  it("snapshots a ~400-node page inside the budget", async () => {
    const dir = temp("psyche-acceptance-browser-");
    const browser = new MockBrowser({ site: typicalPage() });
    // A public-looking origin: the driver's policy refuses loopback targets (security prohibitions).
    browser.origin = (h) => (h === "a" ? "https://guide.example.com" : `https://${h}.example.net`);
    const desktop = new MockDesktop({ browser, quarantineDir: join(dir, "quarantine") });
    const driver = new CdpBridgeDriver(await desktop.connect(), {
      library: new FsQuarantineWriter(join(dir, "library")),
    });
    try {
      // The task's origin set already holds the page's origin (approved earlier in the task).
      const session = await driver.openSession({
        partition: "clean",
        policy: { readOnly: [browser.origin("a")] },
      });
      const tab = await driver.openTab(session.id, `${browser.origin("a")}/guide`);
      const warm = await driver.snapshot(tab.id);
      expect(warm.refs?.length ?? 0).toBeGreaterThan(40);
      const samples: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        const t0 = performance.now();
        await driver.snapshot(tab.id);
        samples.push(performance.now() - t0);
      }
      timings.browserSnapshotMs = Math.round(median(samples));
      timings.browserSnapshotRefs = warm.refs?.length ?? 0;
      expect(timings.browserSnapshotMs).toBeLessThan(BUDGET.browserSnapshotMs * CI_FACTOR);
    } finally {
      desktop.disconnect();
    }
  });
});

describe("memory search on a seeded workspace", () => {
  it("answers a keyword query over a year of daily notes inside the budget", async () => {
    const dir = temp("psyche-acceptance-memory-");
    const db = openDb(":memory:");
    const clock = new FakeClock(Date.parse("2026-10-19T15:30:00Z"));
    const store = new SqliteMemoryStore({
      sqlite: db.sqlite,
      workspaceDir: join(dir, "workspace"),
      clock,
      timeZone: "America/Los_Angeles",
      templatesDir: null,
    });
    await store.init();
    const topics = [
      "dentist",
      "Dana call",
      "heat pumps",
      "Q4 roadmap",
      "farmers market",
      "invoice",
    ];
    const day = 24 * 3_600_000;
    for (let i = 0; i < 365; i += 1) {
      const date = new Date(Date.parse("2025-10-19T12:00:00Z") + i * day)
        .toISOString()
        .slice(0, 10);
      const lines = Array.from(
        { length: 5 },
        (_, k) => `- ${topics[(i + k) % topics.length]} note ${i}.${k}: follow up on item ${k}`,
      );
      await store.appendDailyNote({ text: lines.join("\n"), provenance: "owner", date });
    }
    for (let i = 0; i < 40; i += 1) {
      await store.writeFile(
        `projects/project-${i}.md`,
        `# Project ${i}\n\nGoal: ship milestone ${i}.\n\n- owner: Avery\n- next: ${topics[i % topics.length]}\n`,
        { provenance: "owner" },
      );
    }
    const queries = [
      "dentist",
      "Dana call",
      "heat pumps",
      "milestone 7",
      "farmers market",
      "invoice",
    ];
    await store.search("warm-up");
    const samples: number[] = [];
    for (const q of queries) {
      const t0 = performance.now();
      const hits = await store.search(q, { limit: 10 });
      samples.push(performance.now() - t0);
      expect(hits.length, q).toBeGreaterThan(0);
    }
    timings.memorySearchMs = Math.round(median(samples) * 100) / 100;
    timings.memorySearchCorpus = 365 * 5 + 40;
    expect(timings.memorySearchMs).toBeLessThan(BUDGET.memorySearchMs * CI_FACTOR);
    db.close();
  });
});
