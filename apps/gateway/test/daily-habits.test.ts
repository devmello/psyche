import { getSetting, openDb, setSetting } from "@psyche/db";
import { PsycheNotifier } from "@psyche/notifications";
import { DailyService, FollowupStore, readDailySettings } from "@psyche/proactive";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { connectorToolLookup } from "../src/compose/proactive.ts";
import { notifierRouting } from "../src/compose/quiet-hours.ts";

const LA = () => "America/Los_Angeles";
// 08:00 PDT; 23:00 PDT the evening before.
const MORNING = Date.UTC(2026, 9, 28, 15);
const NIGHT = Date.UTC(2026, 9, 28, 6);

function setup(at: number) {
  const db = openDb(":memory:");
  setSetting(db, "daily.brief.enabled", true);
  const clock = new FakeClock();
  clock.set(at);
  const delivered: string[] = [];
  const notifier = new PsycheNotifier({
    clock,
    delivery: "await",
    routing: notifierRouting(db, LA),
    adapters: [
      {
        name: "os",
        handles: (s) => s === "notification",
        deliver: async (n) => {
          delivered.push(n.title);
          return { status: "delivered" };
        },
      },
    ],
  });
  const kv = {
    get: (k: string) => getSetting(db, k)?.value,
    set: (k: string, v: unknown) => void setSetting(db, k, v),
  };
  const posts: unknown[] = [];
  const daily = new DailyService({
    clock,
    scheduler: undefined as never,
    tools: { get: () => undefined },
    feed: { insert: (p) => void posts.push(p) },
    notifier,
    settings: () => readDailySettings(kv),
    followups: new FollowupStore(kv, () => clock.now()),
    timezone: "America/Los_Angeles",
  });
  return { db, clock, notifier, delivered, daily, posts };
}

describe("daily brief and quiet hours", () => {
  it("notifies at once outside quiet hours", async () => {
    const t = setup(MORNING);
    setSetting(t.db, "notifications.quietHours.enabled", true);
    await t.daily.run("morning");
    expect(t.delivered).toHaveLength(1);
    expect(t.posts).toHaveLength(1);
  });

  it("posts the card but holds the notification inside quiet hours", async () => {
    const t = setup(NIGHT);
    setSetting(t.db, "notifications.quietHours.enabled", true);
    await t.daily.run("morning");
    expect(t.posts).toHaveLength(1);
    expect(t.delivered).toEqual([]);
    t.clock.set(MORNING);
    await t.notifier.flushDue();
    expect(t.delivered).toHaveLength(1);
  });
});

describe("connectorToolLookup (#958) for the daily jobs", () => {
  it("finds a connector's calendar tool by its bare name", () => {
    const tool = { name: "mcp__apple__calendar_list_events" };
    const registry = {
      get: (n: string) => (n === tool.name ? tool : undefined),
      list: () => [tool],
    };
    expect(connectorToolLookup(registry as never).get("calendar_list_events")).toBe(tool);
  });
});
