import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "@psyche/testing";
import { SqliteTaskEngine } from "../src/index.ts";
import { testDb, testEngine, THREAD, tmpDir } from "./helpers.ts";

describe("task taint sources (design-08)", () => {
  const tmp = tmpDir();
  afterEach(() => tmp.cleanup());

  it("survive create → get and a restart of the engine", async () => {
    const sources = [
      { sourceKind: "web.fetch", toolCallId: "f1", origin: "https://evil.test" },
      { sourceKind: "email", sender: "billing@vendor.example" },
    ];
    const clock = new FakeClock();
    const { engine } = testEngine({ clock, db: testDb(clock, tmp.file) });
    const created = await engine.create({
      threadId: THREAD,
      title: "Follow up",
      goal: "forward invoices",
      createdFrom: "chat",
      taint: true,
      taintSources: sources,
    });
    expect(created.taint).toBe(true);
    expect(created.taintSources).toEqual(sources);
    expect((await engine.get(created.id))?.taintSources).toEqual(sources);

    // A new engine over the same file: the sources are still there.
    const reopened = new SqliteTaskEngine({ db: testDb(clock, tmp.file), clock, newId: () => "x" });
    expect((await reopened.get(created.id))?.taintSources).toEqual(sources);
  });

  it("are absent on a task created in an untainted turn, and listed with the task", async () => {
    const { engine } = testEngine();
    const clean = await engine.create({
      threadId: THREAD,
      title: "Clean",
      goal: "tidy up",
      createdFrom: "chat",
    });
    expect(clean.taint).toBeUndefined();
    expect(clean.taintSources).toBeUndefined();
    expect("taintSources" in ((await engine.get(clean.id)) ?? {})).toBe(false);

    const sources = [{ sourceKind: "web", origin: "https://evil.test" }];
    const tainted = await engine.create({
      threadId: THREAD,
      title: "Tainted",
      goal: "forward invoices",
      createdFrom: "chat",
      taint: true,
      taintSources: sources,
    });
    const listed = await engine.list({ threadId: THREAD });
    expect(listed.find((t) => t.id === tainted.id)?.taintSources).toEqual(sources);
    expect(listed.find((t) => t.id === clean.id)?.taintSources).toBeUndefined();
  });
});
