import { SqliteTaskEngine } from "@psyche/tasks";
import { describe, expect, it } from "vitest";
import { createTaskLauncher, mergeTaint } from "../src/index.ts";
import { taintSourcesOf } from "../src/rows.ts";
import { asleep, BASE, setup } from "./helpers.ts";

/** An automation made in a tainted turn keeps the taint for every run (security §3.6). */

const T0 = Date.parse("2026-11-25T09:00:00Z");
const WEB = [{ sourceKind: "web.fetch", origin: "https://example.com/post" }];

function realLauncher() {
  const base = setup({ start: T0, timers: asleep });
  const engine = new SqliteTaskEngine({ db: base.db, clock: base.clock });
  const real = setup({
    start: T0,
    timers: asleep,
    db: base.db,
    launcher: createTaskLauncher({ engine }),
  });
  return { ...real, engine };
}

describe("automation taint", () => {
  it("a tainted turn's schedule: the run's task starts tainted with those sources", async () => {
    const { scheduler, engine } = realLauncher();
    const a = await scheduler.create({
      ...BASE,
      kind: "cron",
      schedule: "0 8 * * *",
      taintSources: WEB,
    });
    // Outward only the kinds: the origin stays on the Gateway.
    expect((await scheduler.get(a.id))?.taintSources).toEqual([{ sourceKind: "web.fetch" }]);
    await scheduler.runNow(a.id);
    const [task] = await engine.list();
    expect(task).toMatchObject({ createdFrom: "automation", taint: true });
    expect(task?.taintSources).toEqual(WEB);
  });

  it("positive control: a clean turn's schedule runs clean", async () => {
    const { scheduler, engine } = realLauncher();
    const a = await scheduler.create({ ...BASE, kind: "cron", schedule: "0 8 * * *" });
    expect((await scheduler.get(a.id))?.taintSources).toBeUndefined();
    await scheduler.runNow(a.id);
    const [task] = await engine.list();
    expect(task?.taint).toBeFalsy();
    expect(task?.taintSources ?? []).toEqual([]);
  });

  it("the taint survives an owner edit of the automation", async () => {
    const { scheduler, launcher } = setup({ start: T0, timers: asleep });
    const a = await scheduler.create({
      ...BASE,
      kind: "cron",
      schedule: "0 8 * * *",
      taintSources: WEB,
    });
    await scheduler.update(a.id, { title: "Renamed", enabled: false });
    await scheduler.update(a.id, { enabled: true });
    await scheduler.runNow(a.id);
    await scheduler.idle();
    expect(launcher.requests[0]?.taintSources).toEqual(WEB);
  });

  it("a damaged stored value still taints, never runs clean", () => {
    expect(taintSourcesOf("not json")).toEqual([{ sourceKind: "stored" }]);
    expect(taintSourcesOf("{}")).toEqual([{ sourceKind: "stored" }]);
    expect(taintSourcesOf("[]")).toEqual([{ sourceKind: "stored" }]);
    expect(taintSourcesOf(JSON.stringify(WEB))).toEqual(WEB);
  });

  it("merges stored and event sources without duplicates", () => {
    expect(mergeTaint(WEB, [{ sourceKind: "email", sender: "a@b.c" }, ...WEB])).toEqual([
      ...WEB,
      { sourceKind: "email", sender: "a@b.c" },
    ]);
    expect(mergeTaint(undefined, [])).toEqual([]);
  });
});
