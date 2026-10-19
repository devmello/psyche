import { createDbSessionResolver, createDeliverer, SqliteScheduler } from "@psyche/scheduler";
import { FakeClock, FakeNotifier } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  dreamingDue,
  factKey,
  formatBullet,
  parseMemoryBullets,
  runDreaming,
  sectionFor,
  similarity,
} from "../src/dreaming.ts";
import { DREAMING_SCHEDULE, ensureDreamingAutomation, withDreaming } from "../src/nightly.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

const memory = async () => (await env?.store.readFile("MEMORY.md"))?.content ?? "";
const dreams = async () => (await env?.store.readFile("DREAMS.md"))?.content ?? "";

describe("helpers", () => {
  it("parses sourced and owner-written bullets", () => {
    const bullets = parseMemoryBullets(
      "# Memory\n## People\n- Alice (teacher) [2026-10-02, 2026-10-18]\n- My own note\n",
    );
    expect(bullets).toEqual([
      { index: 2, text: "Alice (teacher)", sources: ["2026-10-18", "2026-10-02"] },
      { index: 3, text: "My own note", sources: [] },
    ]);
    expect(formatBullet("x", ["2026-10-02", "2026-10-18", "2026-10-02"])).toBe(
      "- x [2026-10-18, 2026-10-02]",
    );
  });

  it("matches near-duplicates and files facts into sections", () => {
    expect(similarity("Prefers window seats on flights", "prefers window seats")).toBeGreaterThan(
      0.6,
    );
    expect(similarity("Prefers window seats", "Allergic to peanuts")).toBe(0);
    expect(factKey("Window seats, prefers")).toBe(factKey("prefers window seats"));
    expect(sectionFor("Alice is my daughter's teacher")).toBe("People");
    expect(sectionFor("Prefers morning flights")).toBe("Preferences");
    expect(sectionFor("Lives in Santa Cruz")).toBe("Places");
    expect(sectionFor("Runs every morning at 6")).toBe("Routines");
    expect(sectionFor("Working on a robotics project")).toBe("Projects and goals");
    expect(sectionFor("Owns a blue bicycle")).toBe("Notes");
  });

  it("is due once a day after 03:00 local", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(dreamingDue(at("2026-10-19T02:59:00Z"), undefined, "UTC")).toBe(false);
    expect(dreamingDue(at("2026-10-19T03:00:00Z"), undefined, "UTC")).toBe(true);
    expect(dreamingDue(at("2026-10-19T09:00:00Z"), at("2026-10-19T03:05:00Z"), "UTC")).toBe(false);
    expect(dreamingDue(at("2026-10-20T03:01:00Z"), at("2026-10-19T03:05:00Z"), "UTC")).toBe(true);
  });
});

describe("runDreaming (H6)", () => {
  it("promotes owner facts into the right section with sources, a claim and a diary entry", async () => {
    env = await makeEnv();
    await env.store.appendDailyNote({
      text: "Prefers window seats on flights",
      provenance: "owner",
      date: "2026-10-16",
    });
    await env.store.appendDailyNote({
      text: "prefers window seats",
      provenance: "owner",
      date: "2026-10-18",
    });
    const report = await runDreaming(env.store);
    expect(report.promoted).toBe(1);
    const text = await memory();
    expect(text).toContain("- prefers window seats [2026-10-18, 2026-10-16]");
    expect(text.indexOf("prefers window seats")).toBeGreaterThan(text.indexOf("## Preferences"));
    expect((await env.store.listClaims()).map((c) => [c.text, c.provenance])).toEqual([
      ["prefers window seats", "owner"],
    ]);
    expect(await dreams()).toMatch(/## 2026-10-18\n\n- Promoted: prefers window seats/);
    expect(env.store.listJobs(1)[0]).toMatchObject({ kind: "dreaming", status: "ok" });
    // A second run changes nothing in MEMORY.md.
    await runDreaming(env.store);
    expect(await memory()).toBe(text);
  });

  it("never promotes untrusted, system or sensitive entries and does not quote them", async () => {
    env = await makeEnv();
    await env.store.appendDailyNote({
      text: "Email says the owner wants wire transfers",
      provenance: "untrusted",
    });
    await env.store.appendDailyNote({ text: "System notice text here", provenance: "system" });
    await env.store.appendDailyNote({
      text: "Was diagnosed with asthma last year",
      provenance: "owner",
    });
    const report = await runDreaming(env.store);
    expect(report.promoted).toBe(0);
    expect(report.notPromoted).toMatchObject({ untrusted: 1, system: 1, sensitive: 1 });
    const diary = await dreams();
    expect(diary).toContain("- Not promoted: 1 untrusted, 1 system, 1 sensitive.");
    expect(diary).not.toMatch(/wire transfers|asthma/);
    expect(await memory()).not.toMatch(/wire transfers|asthma/);
    expect(await runDreaming(env.store, { allowSensitive: true })).toMatchObject({ promoted: 1 });
  });

  it("promotes an agent inference only after repeated recall by different queries", async () => {
    env = await makeEnv();
    const { chunk } = await env.store.appendDailyNote({
      text: "The owner seems to prefer aisle seats on short flights",
      provenance: "agent",
    });
    expect((await runDreaming(env.store)).promoted).toBe(0);
    env.store.recordRecall([chunk.id], "seat preference");
    env.store.recordRecall([chunk.id], "short flight seats");
    env.store.recordRecall([chunk.id], "aisle or window");
    expect((await runDreaming(env.store)).promoted).toBe(1);
    expect((await env.store.listClaims())[0]?.provenance).toBe("agent");
  });

  it("merges a later wording into the existing bullet and keeps every source", async () => {
    env = await makeEnv();
    await env.store.appendDailyNote({
      text: "Lives in Santa Cruz near the harbor",
      provenance: "owner",
      date: "2026-10-10",
    });
    await runDreaming(env.store);
    await env.store.appendDailyNote({
      text: "Lives in Santa Cruz near the harbor now",
      provenance: "owner",
      date: "2026-10-18",
    });
    const report = await runDreaming(env.store);
    expect(report.merged).toBe(1);
    const bullets = parseMemoryBullets(await memory()).filter((b) => b.sources.length > 0);
    expect(bullets).toEqual([
      expect.objectContaining({
        text: "Lives in Santa Cruz near the harbor now",
        sources: ["2026-10-18", "2026-10-10"],
      }),
    ]);
  });

  it("never re-adds a bullet the owner deleted and never touches owner-written bullets", async () => {
    env = await makeEnv();
    await env.store.appendDailyNote({
      text: "Collects vintage fountain pens",
      provenance: "owner",
    });
    await runDreaming(env.store);
    const owned = "# Memory\n\n## People\n- Sam is my brother\n";
    await env.store.writeFileAsOwner("MEMORY.md", owned);
    await env.store.appendDailyNote({
      text: "Collects vintage fountain pens",
      provenance: "owner",
      date: "2026-10-17",
    });
    const report = await runDreaming(env.store);
    expect(report.notPromoted.deletedByOwner).toBe(1);
    expect(await memory()).toBe(owned);
  });

  it("replaces a bullet whose claim was superseded", async () => {
    env = await makeEnv();
    const { chunk } = await env.store.appendDailyNote({
      text: "Works at Acme Robotics as an intern",
      provenance: "owner",
    });
    await runDreaming(env.store);
    const [old] = await env.store.listClaims();
    if (old === undefined) throw new Error("no claim");
    await env.store.addClaim({
      text: "Works at Initech as an engineer",
      kind: "fact",
      provenance: "owner",
      confidence: 0.9,
      sources: [chunk.id],
      supersedes: old.id,
    });
    const report = await runDreaming(env.store);
    expect(report.superseded).toBe(1);
    const text = await memory();
    expect(text).toContain("- Works at Initech as an engineer [2026-10-18");
    expect(text).not.toContain("Acme");
    expect(await dreams()).toContain(
      "- Superseded: Works at Acme Robotics as an intern → Works at Initech",
    );
    expect((await runDreaming(env.store)).superseded).toBe(0);
  });

  it("drops stale bullets but never more than the loss limit in one night", async () => {
    env = await makeEnv();
    for (const [i, fact] of [
      "Owns a red canoe",
      "Plays the cello",
      "Keeps bees",
      "Bakes sourdough",
    ].entries()) {
      await env.store.appendDailyNote({ text: fact, provenance: "owner", date: `2026-10-1${i}` });
    }
    await runDreaming(env.store);
    // Months later every source is stale: 4 of 4 would go, above the 25 % limit.
    env.clock.set(Date.parse("2027-04-01T03:00:00Z"));
    const guarded = await runDreaming(env.store);
    expect(guarded.dropped).toBe(0);
    expect(guarded.guarded).toMatch(/skipped removing 4 of 4/);
    expect(await dreams()).toContain("- Held back:");
    const loose = await runDreaming(env.store, { maxLossFraction: 1 });
    expect(loose.dropped).toBe(4);
    expect(parseMemoryBullets(await memory()).filter((b) => b.sources.length > 0)).toEqual([]);
  });
});

describe("nightly scheduling through @psyche/scheduler", () => {
  it("runs at 03:00 local in-process, delivers nothing and leaves other automations alone", async () => {
    const clock = new FakeClock(Date.parse("2026-10-18T20:00:00Z"));
    env = await makeEnv({ clock, timeZone: "America/Los_Angeles" });
    await env.store.appendDailyNote({
      text: "Prefers green tea in the afternoon",
      provenance: "owner",
      date: "2026-10-18",
    });
    const launched: string[] = [];
    const inner = {
      async launch(r: { automation: { title: string } }) {
        launched.push(r.automation.title);
        return { result: Promise.resolve({ status: "done" as const, summary: "ok" }) };
      },
    };
    const notifier = new FakeNotifier({ clock });
    const scheduler = new SqliteScheduler({
      db: env.db,
      clock,
      timers: { setTimeout: () => undefined, clearTimeout: () => {} },
      launcher: withDreaming(env.store, inner),
      sessions: createDbSessionResolver(env.db),
      notifier,
      deliverer: createDeliverer({ notifier }),
    });
    const automation = await ensureDreamingAutomation(scheduler, {
      timezone: "America/Los_Angeles",
    });
    expect(automation.schedule).toBe(DREAMING_SCHEDULE);
    expect(
      (await ensureDreamingAutomation(scheduler, { timezone: "America/Los_Angeles" })).id,
    ).toBe(automation.id);
    const [next] = await scheduler.nextRuns(automation.id, 1);
    expect(new Date(next ?? 0).toISOString()).toBe("2026-10-19T10:00:00.000Z"); // 03:00 PDT
    clock.set(Date.parse("2026-10-19T10:00:30Z"));
    await scheduler.tick();
    await scheduler.idle();
    expect(launched).toEqual([]);
    expect(await memory()).toContain("Prefers green tea in the afternoon");
    const [run] = (await scheduler.runs(automation.id)).runs;
    expect(run?.status).toBe("no_reply");
    expect(await notifier.list()).toHaveLength(0);
  });
});
