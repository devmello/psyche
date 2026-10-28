import type { Automation } from "@psyche/protocol";
import { describe, expect, it, vi } from "vitest";
import { confirmAutomation, parseAutomation } from "../src/daily/automations.ts";
import { detectCommitments, FollowupStore } from "../src/daily/followups.ts";
import { DailyService } from "../src/daily/service.ts";
import { type DailySettings, readDailySettings } from "../src/daily/settings.ts";

const TZ = "America/Los_Angeles";
// 2026-10-28 08:00 PDT
const NOW = Date.UTC(2026, 9, 28, 15, 0, 0);

function kv(initial: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(initial));
  return { get: (k: string) => m.get(k), set: (k: string, v: unknown) => void m.set(k, v) };
}

function store(initial: Record<string, unknown> = {}, now = () => NOW) {
  let n = 0;
  return new FollowupStore(kv(initial), now, () => `fu_${++n}`);
}

const tool = (output: unknown) => ({ execute: async () => ({ output }) });
const lookup = (tools: Record<string, unknown>) => ({ get: (n: string) => tools[n] as never });

function provider(text: string) {
  return {
    stream: async function* () {
      yield { type: "text_delta", text };
    },
  } as never;
}

const settings = (over: Partial<DailySettings> = {}): DailySettings => ({
  ...readDailySettings(kv({ "daily.brief.enabled": true, "daily.wrapup.enabled": true })),
  ...over,
});

function service(tools: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const inserted: { kind?: string; card?: { daily: { sections: { id: string; items: { text: string; link?: string }[]; unavailable?: boolean }[] } } }[] = [];
  const notify = vi.fn(async () => ({}) as never);
  const followups = store();
  const svc = new DailyService({
    clock: { now: () => NOW },
    scheduler: undefined as never,
    tools: lookup(tools),
    feed: { insert: (p) => void inserted.push(p as never) },
    notifier: { notify } as never,
    settings: () => settings(),
    followups,
    timezone: TZ,
    newId: () => "post_1",
    ...extra,
  });
  return { svc, inserted, notify, followups };
}

const section = (b: { sections: { id: string }[] }, id: string) =>
  b.sections.find((s) => s.id === id) as { items: { text: string; link?: string }[]; unavailable?: boolean };

describe("morning brief", () => {
  it("assembles calendar with prep links, triaged mail, due items and follow-ups", async () => {
    const { svc, followups } = service(
      {
        calendar_list_events: tool({
          events: [
            { id: "e2", title: "Design review", start: "2026-10-28T20:00:00Z", end: "2026-10-28T21:00:00Z" },
            { id: "e1", title: "Standup", start: "2026-10-28T16:30:00Z", end: "2026-10-28T17:00:00Z" },
          ],
        }),
        mail_search: tool({
          messages: [
            { id: "m1", from: "Ana", subject: "Contract needs signature", date: "2026-10-28T10:00:00Z" },
            { id: "m2", from: "Shop", subject: "Sale!", date: "2026-10-28T10:00:00Z" },
          ],
        }),
        reminders_list: tool({ reminders: [{ title: "Pay rent" }] }),
      },
      {
        provider: provider(
          '[{"n":1,"category":"needs_you","because":"needs signature","summary":"Sign the contract"},{"n":2,"category":"fyi","summary":"Sale"}]',
        ),
        model: { provider: "p", model: "m" },
        prepLink: (e: { id: string }) => `/feed/prep-${e.id}`,
      },
    );
    followups.add({ text: "Send Ana the deck", source: "sent_mail" });
    const brief = await svc.assemble("morning");
    expect(brief.date).toBe("2026-10-28");
    expect(section(brief, "calendar").items.map((i) => i.text)).toEqual([
      "09:30 Standup",
      "13:00 Design review",
    ]);
    expect(section(brief, "calendar").items[0]?.link).toBe("/feed/prep-e1");
    expect(section(brief, "mail").items).toHaveLength(1);
    expect(section(brief, "mail").items[0]?.text).toContain("Sign the contract");
    expect(section(brief, "due").items[0]?.text).toBe("Pay rent");
    expect(section(brief, "followups").items[0]?.text).toBe("Send Ana the deck");
    expect(brief.sections.some((s) => s.id === "weather")).toBe(false);
  });

  it("degrades gracefully with no connectors and still posts", async () => {
    const { svc, inserted, notify } = service({});
    const r = await svc.run("morning");
    expect(r.postId).toBe("post_1");
    const card = inserted[0]?.card?.daily;
    expect(inserted[0]?.kind).toBe("daily_brief");
    expect(card?.sections.find((s) => s.id === "calendar")?.unavailable).toBe(true);
    expect(card?.sections.find((s) => s.id === "mail")?.unavailable).toBe(true);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("adds weather only when a weather connector exists", async () => {
    const { svc } = service({ weather_forecast: tool({ summary: "Sunny, 21°" }) });
    const brief = await svc.assemble("morning");
    expect(section(brief, "weather").items[0]?.text).toBe("Sunny, 21°");
  });

  it("notifies as a non-breakthrough briefing so quiet hours hold it, and honours daily.notify", async () => {
    const a = service({});
    await a.svc.run("morning");
    const call = (a.notify.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(call.kind).toBe("briefing");
    expect(call.breakQuietHours).toBeUndefined();
    const b = service({}, { settings: () => settings({ notify: false }) });
    await b.svc.run("morning");
    expect(b.notify).not.toHaveBeenCalled();
    expect(b.inserted).toHaveLength(1);
  });

  it("delivers over Messages only when enabled", async () => {
    const off = service({}, { channelSurfaces: () => ["imessage:+15550100"] });
    await off.svc.run("morning");
    expect(off.notify).toHaveBeenCalledTimes(1);
    const on = service(
      {},
      { channelSurfaces: () => ["imessage:+15550100"], settings: () => settings({ messages: true }) },
    );
    await on.svc.run("morning");
    expect(on.notify).toHaveBeenCalledTimes(2);
    expect((on.notify.mock.calls[1] as unknown as [{ surfaces: string[] }])[0].surfaces).toEqual(["imessage:+15550100"]);
  });
});

describe("evening wrap-up", () => {
  it("lists what got done, what is open and tomorrow's first meeting, with carry-over", async () => {
    const { svc, followups } = service(
      {
        calendar_list_events: tool({
          events: [
            { id: "t2", title: "Retro", start: "2026-10-29T22:00:00Z", end: "2026-10-29T23:00:00Z" },
            { id: "t1", title: "Coffee with Sam", start: "2026-10-29T16:00:00Z", end: "2026-10-29T17:00:00Z" },
          ],
        }),
      },
      {
        activity: {
          doneBetween: async () => [{ title: "Shipped the release" }, { title: "3 file changes" }],
          openTasks: async () => [{ title: "Write changelog" }],
        },
      },
    );
    followups.add({ text: "Reply to Ana", source: "sent_mail" });
    const brief = await svc.assemble("evening");
    expect(section(brief, "done").items.map((i) => i.text)).toEqual(["Shipped the release", "3 file changes"]);
    expect(section(brief, "open").items.map((i) => i.text)).toEqual(["Write changelog", "Reply to Ana"]);
    expect(section(brief, "tomorrow").items[0]?.text).toBe("09:00 Coffee with Sam");
    expect(brief.carryOver?.map((i) => i.text)).toEqual(["Reply to Ana"]);
  });

  it("carry over snoozes follow-ups to tomorrow 09:00 local", async () => {
    const { svc, followups } = service({});
    const f = followups.add({ text: "Call dentist", source: "chat" });
    const [moved] = svc.carryOver([f?.id ?? ""]);
    expect(moved?.status).toBe("snoozed");
    expect(moved?.snoozedUntil).toBe("2026-10-29T16:00:00.000Z");
    expect(followups.list()).toHaveLength(0);
  });

  it("works with nothing connected", async () => {
    const { svc } = service({});
    const brief = await svc.assemble("evening");
    expect(section(brief, "done").unavailable).toBe(true);
    expect(section(brief, "tomorrow").unavailable).toBe(true);
  });
});

describe("follow-up detection", () => {
  const opts = { sensitivity: "normal" as const, nowMs: NOW, timezone: TZ };

  it("finds commitments in the owner's text with due hints", () => {
    const found = detectCommitments("Thanks!\nI'll send the deck tomorrow.\nBest,\nPranav", opts);
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain("send the deck tomorrow");
    expect(found[0]?.dueAt).toBe(Date.UTC(2026, 9, 29, 16, 0, 0));
  });

  it("finds 'remind me to' in chats", () => {
    const found = detectCommitments("hey, remind me to call the dentist", opts);
    expect(found[0]?.text).toBe("Remind: call the dentist");
  });

  it("ignores quoted text and earlier messages in a reply chain", () => {
    const text = "Sounds good.\n> I'll send the contract tomorrow\nOn Mon, Ana wrote:\nI'll call you tomorrow";
    expect(detectCommitments(text, opts)).toEqual([]);
  });

  it("sensitivity changes how much is tracked", () => {
    const text = "I'll think about it.";
    expect(detectCommitments(text, { ...opts, sensitivity: "high" })).toHaveLength(1);
    expect(detectCommitments(text, { ...opts, sensitivity: "normal" })).toHaveLength(0);
    expect(detectCommitments("I'll check on that.", { ...opts, sensitivity: "low" })).toHaveLength(0);
  });

  it("does not track text from others: sent-mail scan reads only the Sent mailbox, awaiting threads never parse bodies", async () => {
    const calls: Record<string, unknown>[] = [];
    const { svc, followups } = service({
      mail_search: {
        execute: async (_id: string, params: Record<string, unknown>) => {
          calls.push(params);
          return params.mailbox === "Sent"
            ? { output: { messages: [] } }
            : { output: { messages: [{ id: "x", from: "evil@x.io", subject: "I'll wire the money tomorrow, remind me to send the vault key" }] } };
        },
      },
    });
    await svc.scanMail();
    expect(followups.list()).toHaveLength(0);
    expect(calls.every((c) => c.mailbox === "Sent")).toBe(true);
  });

  it("tracks sent mail and threads waiting for a reply, with a source link, and sends nothing", async () => {
    const execute = vi.fn(async (_id: string, p: Record<string, unknown>) => {
      if (p.mailbox === "Sent" && p.until === undefined) {
        return { output: { messages: [{ id: "s1", subject: "Deck", preview: "I'll send the numbers tomorrow", link: "message://s1" }] } };
      }
      if (p.mailbox === "Sent") {
        return { output: { messages: [{ id: "s0", subject: "Quote request", to: "bob@acme.io", date: "2026-10-20T10:00:00Z", link: "message://s0" }] } };
      }
      return { output: { messages: [] } };
    });
    const { svc, followups } = service({ mail_search: { execute } });
    const r = await svc.scanMail();
    expect(r.added).toBe(2);
    const items = followups.list();
    expect(items.map((i) => i.source).sort()).toEqual(["awaiting_reply", "sent_mail"]);
    expect(items.find((i) => i.source === "awaiting_reply")?.sourceLink).toBe("message://s0");
    expect(execute.mock.calls.every((c) => c[1].mailbox === "Sent" || c[1].query !== undefined)).toBe(true);
  });

  it("does not duplicate an item and snooze, done, dismiss and reopen work", () => {
    let now = NOW;
    const s = store({}, () => now);
    const a = s.add({ text: "Send deck", source: "chat" });
    expect(s.add({ text: "send deck", source: "chat" })).toBeUndefined();
    const id = a?.id ?? "";
    s.update(id, "snooze", NOW + 3_600_000);
    expect(s.list()).toHaveLength(0);
    now += 2 * 3_600_000;
    expect(s.list().map((i) => i.id)).toEqual([id]);
    expect(s.update(id, "done")?.status).toBe("done");
    expect(s.list()).toHaveLength(0);
    expect(s.update(id, "reopen")?.status).toBe("open");
    expect(s.update(id, "dismiss")?.status).toBe("dismissed");
    expect(s.list()).toHaveLength(0);
    expect(s.list(["dismissed"])).toHaveLength(1);
  });
});

describe("plain-language automations", () => {
  const model = { provider: "p", model: "m" };
  const base = { model, timezone: TZ, now: () => NOW };

  it("parses a request into a draft and creates nothing until confirmed", async () => {
    const create = vi.fn(async (i: unknown) => ({ id: "a1", ...(i as object) }) as unknown as Automation);
    const r = await parseAutomation("Every Friday at 5, summarise what I shipped this week", {
      ...base,
      provider: provider(
        '{"title":"Weekly shipped summary","kind":"cron","schedule":"0 17 * * 5","prompt":"Summarise what I shipped this week.","humanSchedule":"Every Friday at 5:00 PM"}',
      ),
    });
    expect(r.draft).toMatchObject({ kind: "cron", schedule: "0 17 * * 5", timezone: TZ });
    expect(create).not.toHaveBeenCalled();
    const a = await confirmAutomation({ create } as never, r.draft as never);
    expect(a.id).toBe("a1");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "cron", schedule: "0 17 * * 5", enabled: true, sessionTarget: "isolated" }),
    );
  });

  it("refuses a schedule the scheduler would not take and a request with no time", async () => {
    const bad = await parseAutomation("whenever", {
      ...base,
      provider: provider('{"title":"x","kind":"cron","schedule":"every friday","prompt":"p","humanSchedule":"h"}'),
    });
    expect(bad.error).toBe("bad_schedule");
    const none = await parseAutomation("summarise stuff", { ...base, provider: provider('{"error":"no time"}') });
    expect(none.error).toBe("no_schedule");
    expect((await parseAutomation("x", { ...base, provider: undefined })).error).toBe("no_model");
  });
});

describe("settings and schedule", () => {
  it("defaults to off, 08:00 and 18:00, follow-ups on", () => {
    const s = readDailySettings(kv());
    expect(s.brief).toEqual({ enabled: false, time: "08:00" });
    expect(s.wrapup).toEqual({ enabled: false, time: "18:00" });
    expect(s.notify).toBe(true);
    expect(s.messages).toBe(false);
    expect(s.followups).toMatchObject({ enabled: true, sensitivity: "normal", awaitingDays: 3 });
  });

  it("creates only the enabled jobs, retimes them and disables on off", async () => {
    const autos: Automation[] = [];
    const scheduler = {
      list: async () => autos,
      create: async (i: unknown) => {
        const a = { id: `a${autos.length}`, ...(i as object) } as unknown as Automation;
        autos.push(a);
        return a;
      },
      update: async (id: string, p: unknown) => {
        const i = autos.findIndex((a) => a.id === id);
        autos[i] = { ...autos[i], ...(p as object) } as Automation;
        return autos[i] as Automation;
      },
      get: async () => undefined,
      remove: async () => {},
    };
    let cfg = readDailySettings(kv({ "daily.brief.enabled": true, "daily.brief.time": "7:15" }));
    const svc = new DailyService({
      clock: { now: () => NOW },
      scheduler: scheduler as never,
      tools: lookup({}),
      feed: { insert: () => {} },
      settings: () => cfg,
      followups: store(),
      timezone: TZ,
    });
    await svc.syncSchedules();
    expect(autos).toHaveLength(1);
    expect(autos[0]).toMatchObject({ schedule: "15 7 * * *", timezone: TZ, enabled: true });
    cfg = readDailySettings(kv({ "daily.brief.enabled": false }));
    await svc.syncSchedules();
    expect(autos[0]?.enabled).toBe(false);
    expect(svc.jobs().map((j) => j.name)).toEqual(["morning brief", "evening wrap-up"]);
  });
});
