import { type AgentToolRegistration, defineTool } from "@psyche/agent-core";
import { createDbSessionResolver, SqliteScheduler } from "@psyche/scheduler";
import { createIdGenerator, FakeClock, FakeNotifier } from "@psyche/testing";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  appleMailSource,
  gmailSource,
  MailWatcher,
  type MailWatcherOptions,
  OFF_HOURS_POLL_MS,
  withProactiveJobs,
} from "../src/index.ts";
import { asleep, RecordingLauncher, testDb } from "./helpers.ts";

/** The new-mail poller (spec §4.7; #670 W3) on the real scheduler with fake mail tools. */

const NOON = Date.parse("2026-10-26T12:00:00Z");

function rig(start = NOON, extra: Partial<MailWatcherOptions> = {}) {
  const clock = new FakeClock(start);
  const db = testDb(clock);
  const agent = new RecordingLauncher();
  const ids = createIdGenerator({ prefix: "s" });
  const inbox: { id: string; from: string; subject: string; date: string }[] = [];
  const queries: unknown[] = [];
  const tools = new Map<string, AgentToolRegistration>([
    [
      "mail_search",
      defineTool({
        name: "mail_search",
        description: "search",
        input: Type.Object({}, { additionalProperties: true }),
        sideEffect: "read",
        provenanceOut: "untrusted",
        run: async (p) => {
          queries.push(p);
          const since = (p as { since: string }).since;
          return {
            output: {
              messages: inbox
                .filter((m) => m.date >= since)
                .map((m) => ({ ...m, mailbox: "INBOX", account: "Work", read: false })),
            },
            provenance: "untrusted",
          };
        },
      }),
    ],
  ]);
  let watcher: MailWatcher | null = null;
  const scheduler = new SqliteScheduler({
    db,
    clock,
    timers: asleep,
    newId: () => ids.next(),
    launcher: withProactiveJobs(agent, {
      get jobs() {
        return watcher === null ? [] : [watcher.job()];
      },
    }),
    sessions: createDbSessionResolver(db),
    notifier: new FakeNotifier({ clock }),
  });
  watcher = new MailWatcher({
    scheduler,
    clock,
    sources: () => [appleMailSource({ get: (n) => tools.get(n) })],
    timezone: "UTC",
    ...extra,
  });
  return { clock, scheduler, agent, inbox, queries, watcher, tools };
}

describe("mail watch", () => {
  it("publishes new mail as events once; the matching event automation runs once per message", async () => {
    const r = rig();
    const onMail = await r.scheduler.create({
      kind: "event",
      title: "On new mail",
      schedule: "",
      timezone: "UTC",
      prompt: "Look at it",
      trigger: { type: "event", source: "mail.received", debounceMs: 0 },
    });
    r.inbox.push({
      id: "m1",
      from: "Dana <dana@example.com>",
      subject: "Contract",
      date: new Date(NOON - 5 * 60_000).toISOString(),
    });
    expect(await r.watcher.poll()).toEqual({ published: 1 });
    // The first poll looked back one hour; the next one starts at this poll's time.
    expect((r.queries[0] as { since: string }).since).toBe(
      new Date(NOON - 3_600_000).toISOString(),
    );
    r.clock.advance(10 * 60_000);
    r.inbox.push({
      id: "m2",
      from: "Lee",
      subject: "Lunch",
      date: new Date(r.clock.now() - 60_000).toISOString(),
    });
    expect(await r.watcher.poll()).toEqual({ published: 1 });
    expect((r.queries[1] as { since: string }).since).toBe(new Date(NOON).toISOString());
    await r.scheduler.flushEvents();
    await r.scheduler.idle();
    const runs = r.scheduler.runs(onMail.id).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.events?.map((e) => [e.id, e.from, e.subject])).toEqual([
      ["mail:apple:Work:m1", "Dana <dana@example.com>", "Contract"],
      ["mail:apple:Work:m2", "Lee", "Lunch"],
    ]);
    // Polling the same window again publishes nothing new (dedupe by message id).
    expect(await r.watcher.poll()).toEqual({ published: 0 });
  });

  it("outside active hours it polls at most hourly; with no listener it reads nothing", async () => {
    const night = Date.parse("2026-10-26T23:30:00Z");
    const r = rig(night);
    expect(await r.watcher.poll()).toEqual({
      published: 0,
      skipped: "nothing listens for new mail",
    });
    await r.scheduler.create({
      kind: "event",
      title: "x",
      schedule: "",
      timezone: "UTC",
      prompt: "x",
      trigger: { type: "event", source: "mail.received" },
    });
    expect((await r.watcher.poll()).skipped).toBeUndefined();
    r.clock.advance(10 * 60_000);
    expect(await r.watcher.poll()).toEqual({ published: 0, skipped: "outside active hours" });
    r.clock.advance(OFF_HOURS_POLL_MS);
    expect((await r.watcher.poll()).skipped).toBeUndefined();
    expect(r.queries).toHaveLength(2);
  });

  it("runs as a system interval automation in-process; nothing reaches the agent", async () => {
    const r = rig();
    const a = await r.watcher.ensureSchedule({ timezone: "UTC" });
    expect(a).toMatchObject({ kind: "interval", schedule: "PT10M", title: "Check for new mail" });
    expect((await r.watcher.ensureSchedule()).id).toBe(a.id);
    await r.scheduler.trigger(a.id);
    await r.scheduler.idle();
    expect(r.agent.requests).toEqual([]);
    expect(r.scheduler.runs(a.id).runs[0]).toMatchObject({
      status: "no_reply",
      summary: "skipped: nothing listens for new mail",
    });
  });

  it("a source whose tool is missing or fails does not stop the others", async () => {
    const r = rig();
    const errors: unknown[] = [];
    const tools = { get: (n: string) => r.tools.get(n) };
    const watcher = new MailWatcher({
      scheduler: r.scheduler,
      clock: r.clock,
      sources: () => [gmailSource(tools), appleMailSource(tools)],
      timezone: "UTC",
      onError: (e) => errors.push(e),
    });
    r.inbox.push({
      id: "m9",
      from: "Ann",
      subject: "Hi",
      date: new Date(NOON - 60_000).toISOString(),
    });
    await r.scheduler.create({
      kind: "event",
      title: "x",
      schedule: "",
      timezone: "UTC",
      prompt: "x",
      trigger: { type: "event", source: "mail.received" },
    });
    expect(await watcher.poll()).toEqual({ published: 1 });
    expect(errors).toEqual([]);
  });
});

describe("the poll cadence follows Settings → Mail & meetings", () => {
  const listen = (r: ReturnType<typeof rig>) =>
    r.scheduler.create({
      kind: "event",
      title: "x",
      schedule: "",
      timezone: "UTC",
      prompt: "x",
      trigger: { type: "event", source: "mail.received" },
    });

  it("the owner's idle cadence replaces the hourly default outside active hours", async () => {
    const night = Date.parse("2026-10-26T23:30:00Z");
    const r = rig(night, { idleMs: () => 15 * 60_000 });
    await listen(r);
    expect((await r.watcher.poll()).skipped).toBeUndefined();
    r.clock.advance(10 * 60_000);
    expect((await r.watcher.poll()).skipped).toBe("outside active hours");
    r.clock.advance(6 * 60_000);
    expect((await r.watcher.poll()).skipped).toBeUndefined();
  });

  it("the active cadence is the system automation's interval", async () => {
    const r = rig();
    expect((await r.watcher.ensureSchedule({ activeMin: 2 })).schedule).toBe("PT2M");
    expect((await r.watcher.ensureSchedule({})).schedule).toBe("PT10M");
  });
});
