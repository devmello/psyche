import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, setSetting } from "@psyche/db";
import { GraphStore } from "@psyche/memory";
import { MEMORY_WORK_SETTING_KEY } from "@psyche/protocol";
import type { AppleSourceDeps } from "@psyche/search";
import { FakeClock } from "@psyche/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { AppleSearchSeams } from "../src/compose/search-apple.ts";
import {
  appleWorkSources,
  composeWork,
  eventRecords,
  reminderRecords,
  type WorkSources,
  workSettings,
} from "../src/compose/work.ts";

// Wednesday 2026-11-04, 18:00 UTC.
const NOW = Date.parse("2026-11-04T18:00:00Z");
const DAY = 86_400_000;
const CONSENT = { enabled: true, consentedAt: "2026-11-01T00:00:00.000Z" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const clock = new FakeClock(NOW);
  const db = openDb(":memory:");
  const graph = new GraphStore({ sqlite: db.sqlite, clock });
  const course = graph.createEntity({
    kind: "project",
    name: "MATH 21 (Fall 2026)",
    projectType: "course",
  });
  return { clock, db, graph, course };
}

const empty: WorkSources = {
  reminders: async () => [],
  events: async () => [],
  files: async () => [],
  folders: async () => [],
};

describe("settings", () => {
  it("are off until the owner has consented, and a bad value reads as the default", () => {
    expect(workSettings(undefined)).toEqual({
      enabled: false,
      trackedLists: {},
      anchorsFromFolders: "anchored_only",
    });
    expect(workSettings({ enabled: true }).enabled).toBe(false);
    expect(workSettings({ enabled: true, consentedAt: "2026-11-01T00:00:00.000Z" }).enabled).toBe(
      true,
    );
    const s = workSettings({
      ...CONSENT,
      trackedLists: { a: "ent_1", "": "x", b: 3 },
      anchorsFromFolders: "everything",
    });
    expect(s.trackedLists).toEqual({ a: "ent_1" });
    expect(s.anchorsFromFolders).toBe("anchored_only");
  });
});

describe("the Gateway pass", () => {
  it("does nothing while work tracking is off or has not been consented", async () => {
    const { clock, db, graph } = setup();
    let reads = 0;
    const work = composeWork({
      db,
      clock,
      people: { graph },
      sources: {
        ...empty,
        reminders: async () => {
          reads++;
          return [];
        },
      },
    });
    expect((await work.run()).ran).toBe(false);
    setSetting(db, MEMORY_WORK_SETTING_KEY, { enabled: true });
    expect((await work.run()).ran).toBe(false);
    expect(reads).toBe(0);
    setSetting(db, MEMORY_WORK_SETTING_KEY, CONSENT);
    expect((await work.run()).ran).toBe(true);
    expect(reads).toBe(1);
  });

  it("reads the tracked lists from settings, and one failing source does not stop the rest", async () => {
    const { clock, db, graph, course } = setup();
    setSetting(db, MEMORY_WORK_SETTING_KEY, {
      ...CONSENT,
      trackedLists: { "list-math": course.id },
    });
    const asked: string[][] = [];
    const work = composeWork({
      db,
      clock,
      people: { graph },
      sources: {
        ...empty,
        reminders: async (listIds) => {
          asked.push([...listIds]);
          return [
            {
              id: "r1",
              listId: "list-math",
              title: "Lecture Work 7",
              due: "2026-11-06T23:59:00Z",
              completed: true,
              completedAt: "2026-11-04T12:00:00Z",
              trusted: true,
            },
          ];
        },
        events: async () => {
          throw new Error("calendar unavailable");
        },
      },
    });
    const result = await work.run();
    expect(result.failed).toEqual(["events"]);
    expect(asked).toEqual([["list-math"]]);
    expect(result.report?.created).toBe(1);
    const [item] = graph.search("Lecture Work 7", { kinds: ["assignment"] });
    expect(item).toMatchObject({ workStatus: "done" });
    const fact = graph.facts(item?.id ?? "").find((f) => f.attribute === "status");
    expect(fact?.sources.at(-1)).toBe("reminders:r1");
  });

  it("the timer is off in tests and stop is safe", () => {
    const { clock, db, graph } = setup();
    const part = composeWork({
      db,
      clock,
      people: { graph },
      sources: empty,
      intervalMs: 0,
    }).part();
    part.start?.({} as never);
    part.stop?.();
  });
});

/** The Apple connector's own answers for the fixture, so the trust path is the real one. */
function fakeApple(): { seams: AppleSearchSeams; calls: { tool: string; params: unknown }[] } {
  const calls: { tool: string; params: unknown }[] = [];
  const reminders = [
    // The owner's own list: the helper attests the row is theirs.
    {
      id: "r1",
      listId: "list-math",
      list: "MATH 21",
      title: "Lecture Work 7",
      due: "2026-11-06T23:59:00Z",
      completed: false,
      shared: false,
    },
    {
      id: "r2",
      listId: "list-math",
      list: "MATH 21",
      title: "Lecture Work 6",
      due: "2026-10-30T23:59:00Z",
      completed: true,
      completedAt: "2026-10-30T20:00:00Z",
      shared: false,
    },
    // A list someone else shares: not the owner's.
    {
      id: "r3",
      listId: "list-math",
      list: "MATH 21",
      title: "Lab report 2",
      due: "2026-11-12T23:59:00Z",
      completed: false,
      shared: true,
    },
  ];
  const events = [
    {
      id: "e1",
      calendarId: "cal-school",
      calendar: "School",
      title: "MATH 21: Final project due",
      start: "2026-12-10T23:59:00Z",
      own: true,
    },
    {
      id: "e2",
      calendarId: "cal-shared",
      calendar: "Shared",
      title: "Lab 3 due",
      start: "2026-11-08T23:59:00Z",
      own: false,
    },
    {
      id: "e3",
      calendarId: "cal-school",
      calendar: "School",
      title: "MATH 21 Lecture",
      start: "2026-11-04T17:40:00Z",
      recurrence: { frequency: "weekly" },
      own: true,
    },
  ];
  const deps: AppleSourceDeps = {
    call: (app) =>
      app === "reminders"
        ? async (tool, params) => {
            calls.push({ tool, params });
            const p = params as { completed?: boolean; listIds?: string[] };
            return {
              reminders: reminders.filter(
                (r) =>
                  (p.completed === undefined || r.completed === p.completed) &&
                  (p.listIds === undefined || p.listIds.includes(r.listId)),
              ),
            };
          }
        : app === "calendar"
          ? async (tool, params) => {
              calls.push({ tool, params });
              return { events };
            }
          : undefined,
    helper: () => undefined,
    ownAddresses: () => [],
    refreshTrust: async () => undefined,
    owned: (app, row) =>
      app === "reminders" ? row.shared === false : app === "calendar" ? row.own === true : false,
    now: () => NOW,
  };
  return { seams: { deps, refresh: async () => undefined }, calls };
}

describe("the Apple sources", () => {
  it("turn the connector's rows into records with its own trust check, and read only", async () => {
    const { seams, calls } = fakeApple();
    const src = appleWorkSources(seams, () => []);
    const rs = await src.reminders(["list-math"], new AbortController().signal);
    expect(rs.map((r) => [r.id, r.trusted, r.completed])).toEqual([
      ["r1", true, false],
      ["r3", false, false],
      ["r2", true, true],
    ]);
    const es = await src.events(NOW - 14 * DAY, NOW + 120 * DAY, new AbortController().signal);
    expect(es.map((e) => [e.id, e.trusted, e.seriesId])).toEqual([
      ["e1", true, undefined],
      ["e2", false, undefined],
      ["e3", true, "cal-school:math 21 lecture"],
    ]);
    expect(calls.map((c) => c.tool).sort()).toEqual([
      "calendar_list_events",
      "reminders_list",
      "reminders_list",
      "reminders_list",
    ]);
  });

  it("run end to end: statuses from the owner's rows, suggestions from the rest", async () => {
    const { clock, db, graph, course } = setup();
    setSetting(db, MEMORY_WORK_SETTING_KEY, {
      ...CONSENT,
      trackedLists: { "list-math": course.id },
    });
    const { seams } = fakeApple();
    const work = composeWork({
      db,
      clock,
      people: { graph },
      apple: seams,
      broker: { policy: { folders: [] } },
    });
    const result = await work.run();
    expect(result.failed).toEqual([]);
    const names = (kind: "assignment") =>
      graph
        .listEntities([kind])
        .map((a) => [a.name, a.workStatus])
        .sort();
    expect(names("assignment")).toEqual([
      ["Final project", "not_started"],
      ["Lecture Work 6", "done"],
      ["Lecture Work 7", "not_started"],
    ]);
    expect(
      graph
        .suggestions()
        .map((s) => s.name)
        .sort(),
    ).toEqual(["Lab 3", "Lab report 2"]);
    // The series anchored to the course; a second pass changes nothing.
    expect(graph.anchors({ entityId: course.id, kind: "calendar_series" })).toHaveLength(1);
    const again = await work.run();
    expect(again.report).toMatchObject({ created: 0, suggestions: 0, statusChanges: [] });
  });

  it("sweeps only anchored folders inside a granted folder, and reads names and times only", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "psyche-work-")));
    dirs.push(root);
    const granted = join(root, "School");
    const hw7 = join(granted, "MATH21", "hw7");
    const elsewhere = join(root, "Elsewhere", "MATH21");
    mkdirSync(hw7, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    const touch = (path: string, at: number) => {
      writeFileSync(path, "contents are never read");
      utimesSync(path, at / 1000, at / 1000);
    };
    touch(join(hw7, "hw7.tex"), NOW - DAY);
    touch(join(hw7, "old.tex"), NOW - 30 * DAY);
    touch(join(hw7, ".hidden"), NOW - DAY);
    touch(join(elsewhere, "x.tex"), NOW - DAY);
    const { seams } = fakeApple();
    const src = appleWorkSources(seams, () => [{ path: granted }]);
    const signal = new AbortController().signal;
    const files = await src.files([hw7, elsewhere], NOW - 7 * DAY, signal);
    expect(files.map((f) => [f.path, f.owner])).toEqual([[join(hw7, "hw7.tex"), true]]);
    const folders = await src.folders(signal);
    expect(folders.map((f) => f.path).sort()).toEqual([join(granted, "MATH21"), hw7]);
  });
});

describe("rows", () => {
  it("drop rows without an id or a title, and keep dates as given", () => {
    const rs = reminderRecords(
      [{ id: "a" }, { title: "x" }, { id: "b", title: "T", dueDate: "2026-11-06", listId: "l" }],
      () => false,
    );
    expect(rs).toMatchObject([
      { id: "b", title: "T", due: "2026-11-06", listId: "l", trusted: false },
    ]);
    expect(eventRecords([{ id: "e", title: "X" }], () => true)).toEqual([]);
  });
});
