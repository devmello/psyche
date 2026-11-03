import type { DailyBrief } from "@psyche/protocol";
import { describe, expect, it, vi } from "vitest";
import { FollowupStore } from "../src/daily/followups.ts";
import { type DailyCatchUp, DailyService } from "../src/daily/service.ts";
import { type DailySettings, readDailySettings } from "../src/daily/settings.ts";

const TZ = "America/Los_Angeles";
// 2026-10-28 08:00 PDT
const NOW = Date.UTC(2026, 9, 28, 15, 0, 0);

function kv(initial: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(initial));
  return { get: (k: string) => m.get(k), set: (k: string, v: unknown) => void m.set(k, v) };
}

const tool = (output: unknown) => ({ execute: async () => ({ output }) });
const lookup = (tools: Record<string, unknown>) => ({ get: (n: string) => tools[n] as never });

const TOOLS = {
  calendar_list_events: tool({
    events: [
      { id: "e1", title: "Standup", start: "2026-10-28T16:30:00Z", end: "2026-10-28T17:00:00Z" },
    ],
  }),
  reminders_list: tool({
    reminders: [{ title: "Lecture Work 7" }, { title: "Pay rent" }],
  }),
  weather_forecast: tool({ summary: "Sunny" }),
};

const settings = (over: Partial<DailySettings> = {}): DailySettings => ({
  ...readDailySettings(kv({ "daily.brief.enabled": true, "daily.wrapup.enabled": true })),
  ...over,
});

function catchUp(over: Partial<DailyCatchUp> = {}): DailyCatchUp {
  return {
    enabled: () => true,
    morning: () => ({
      lines: [
        {
          text: "MATH 21 · Lecture Work 7: due Thu, in progress.",
          link: "/memory?entity=a1",
          title: "Lecture Work 7",
        },
        {
          text: "Q3 board deck: due tomorrow, not started.",
          link: "/memory?entity=a2",
          title: "Q3 board deck",
        },
      ],
      pending: { text: "2 new assignments to confirm", link: "/memory/review" },
    }),
    evening: () => ({
      worked: [{ text: "Lecture Work 7: edited files.", link: "/memory?entity=a1" }],
      dueTomorrow: [
        { text: "Q3 board deck: due tomorrow, not started.", link: "/memory?entity=a2" },
      ],
    }),
    notice: () => undefined,
    ...over,
  };
}

function service(extra: Record<string, unknown> = {}, tools: Record<string, unknown> = TOOLS) {
  const inserted: { card?: { daily: DailyBrief }; bodyMd?: string }[] = [];
  const notify = vi.fn(async () => ({}) as never);
  let n = 0;
  const followups = new FollowupStore(
    kv(),
    () => NOW,
    () => `fu_${++n}`,
  );
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

const ids = (b: DailyBrief) => b.sections.map((s) => s.id);
const section = (b: DailyBrief, id: string) => b.sections.find((s) => s.id === id);

describe("the brief with work memory on (§5.5)", () => {
  it("shows Catching up in the place of due, in the same position", async () => {
    const { svc } = service({ catchUp: catchUp() });
    const brief = await svc.assemble("morning");
    expect(ids(brief)).toEqual(["calendar", "mail", "catching_up", "followups", "weather"]);
    expect(section(brief, "catching_up")?.title).toBe("Catching up");
    expect(section(brief, "due")).toBeUndefined();
  });

  it("lists the ranked lines, then the reminders no line covers, then the pending count", async () => {
    const { svc } = service({ catchUp: catchUp() });
    const items = section(await svc.assemble("morning"), "catching_up")?.items ?? [];
    expect(items.map((i) => i.text)).toEqual([
      "MATH 21 · Lecture Work 7: due Thu, in progress.",
      "Q3 board deck: due tomorrow, not started.",
      // "Lecture Work 7" is covered by its line; "Pay rent" is not work, so it stays.
      "Pay rent",
      "2 new assignments to confirm",
    ]);
    expect(items[0]?.link).toBe("/memory?entity=a1");
    expect(items.at(-1)?.link).toBe("/memory/review");
  });

  it("is not drawn when there is nothing to catch up on", async () => {
    const { svc } = service(
      { catchUp: catchUp({ morning: () => ({ lines: [] }) }) },
      { calendar_list_events: TOOLS.calendar_list_events },
    );
    const brief = await svc.assemble("morning");
    expect(section(brief, "catching_up")).toBeUndefined();
    expect(section(brief, "due")).toBeUndefined();
  });

  it("with work off, due is exactly what it was", async () => {
    const plain = await service().svc.assemble("morning");
    const off = await service({ catchUp: catchUp({ enabled: () => false }) }).svc.assemble(
      "morning",
    );
    expect(off).toEqual(plain);
    expect(ids(plain)).toContain("due");
    expect(section(plain, "due")?.items.map((i) => i.text)).toEqual(["Lecture Work 7", "Pay rent"]);
    // And the evening is the same too.
    const evening = await service().svc.assemble("evening");
    expect(
      await service({ catchUp: catchUp({ enabled: () => false }) }).svc.assemble("evening"),
    ).toEqual(evening);
  });

  it("shows a follow-up that names a ranked item once, inside that item's line", async () => {
    const { svc, followups } = service({ catchUp: catchUp() });
    followups.add({ text: "Ask Prof about Q3 board deck", source: "chat" });
    followups.add({ text: "Call the dentist", source: "chat" });
    const brief = await svc.assemble("morning");
    expect(section(brief, "catching_up")?.items[1]?.text).toBe(
      "Q3 board deck: due tomorrow, not started. Follow-up: Ask Prof about Q3 board deck",
    );
    expect(section(brief, "followups")?.items.map((i) => i.text)).toEqual(["Call the dentist"]);
  });

  it("keeps a follow-up in its own section when it would not fit in the line", async () => {
    const { svc, followups } = service({ catchUp: catchUp() });
    const long = `Q3 board deck ${"x".repeat(200)}`;
    followups.add({ text: long, source: "chat" });
    const brief = await svc.assemble("morning");
    expect(section(brief, "followups")?.items).toHaveLength(1);
    expect(section(brief, "catching_up")?.items[1]?.text).not.toContain("Follow-up");
  });

  it("stays within the eight-section cap with every provider present", async () => {
    const line = (text: string) => ({ text, link: "/agent/soul?entity=p1" });
    const { svc, followups } = service({
      catchUp: catchUp(),
      comingUp: () => [line("Ava turns 7 on Friday")],
      keepInTouch: () => [line("You haven't replied to Sam")],
      learned: () => ({ text: "Psyche learned 2 things yesterday", link: "/memory/review" }),
      provider: undefined,
    });
    followups.add({ text: "Send the deck", source: "chat" });
    const brief = await svc.assemble("morning");
    expect(ids(brief)).toEqual([
      "calendar",
      "mail",
      "catching_up",
      "followups",
      "weather",
      "coming_up",
      "keep_in_touch",
      "learned",
    ]);
    expect(brief.sections.length).toBeLessThanOrEqual(8);
    // Work off: the same eight, with due where catching_up was.
    const off = await service({
      comingUp: () => [line("Ava turns 7 on Friday")],
      keepInTouch: () => [line("You haven't replied to Sam")],
      learned: () => ({ text: "x" }),
    }).svc.assemble("morning");
    expect(ids(off).filter((i) => i === "due")).toEqual(["due"]);
    expect(off.sections.length).toBeLessThanOrEqual(8);
  });
});

describe("the wrap-up with work memory on", () => {
  it("adds Worked on today, and what is due tomorrow joins Tomorrow", async () => {
    const { svc } = service({ catchUp: catchUp() });
    const brief = await svc.assemble("evening");
    expect(ids(brief)).toEqual(["done", "open", "tomorrow", "worked_on"]);
    expect(section(brief, "worked_on")).toMatchObject({
      title: "Worked on today",
      items: [{ text: "Lecture Work 7: edited files.", link: "/memory?entity=a1" }],
    });
    expect(section(brief, "tomorrow")?.items.map((i) => i.text)).toContain(
      "Q3 board deck: due tomorrow, not started.",
    );
  });

  it("does not draw Worked on today when nothing was worked on", async () => {
    const { svc } = service({
      catchUp: catchUp({ evening: () => ({ worked: [], dueTomorrow: [] }) }),
    });
    expect(ids(await svc.assemble("evening"))).toEqual(["done", "open", "tomorrow"]);
  });

  it("caps Worked on today at five lines of at most 140 characters", async () => {
    const worked = Array.from({ length: 9 }, (_, i) => ({ text: `${"w".repeat(300)} ${i}` }));
    const { svc } = service({ catchUp: catchUp({ evening: () => ({ worked, dueTomorrow: [] }) }) });
    const items = section(await svc.assemble("evening"), "worked_on")?.items ?? [];
    expect(items).toHaveLength(5);
    for (const i of items) expect(i.text.length).toBeLessThanOrEqual(140);
  });
});

describe("a brief delivered to a channel", () => {
  const settingsOn = () => settings({ notify: true, messages: true });

  it("gets the channel copy of work lines and no birthdays or people", async () => {
    const { svc, notify } = service({
      settings: settingsOn,
      channelSurfaces: () => ["imessage:me"],
      catchUp: catchUp({
        morning: (surface) => ({
          lines: [
            {
              text:
                surface === "channel"
                  ? "Q3 board deck: due tomorrow, not started."
                  : "Q3 board deck: due tomorrow, not started. New: Sam: “Updated numbers” (Mon)",
              title: "Q3 board deck",
            },
          ],
        }),
      }),
      comingUp: (surface?: string) =>
        surface === "channel" ? [] : [{ text: "Ava turns 7 on Friday" }],
      keepInTouch: (surface?: string) =>
        surface === "channel" ? [] : [{ text: "You haven't replied to Sam" }],
    });
    await svc.run("morning");
    const calls = notify.mock.calls as unknown as { surfaces: string[]; body: string }[][];
    const feed = calls.find((c) => c[0]?.surfaces.includes("desktop"));
    const channel = calls.find((c) => c[0]?.surfaces.includes("imessage:me"));
    expect(feed).toBeDefined();
    expect(channel?.[0]?.body).toContain("Q3 board deck: due tomorrow, not started.");
    expect(channel?.[0]?.body).not.toContain("Updated numbers");
    expect(channel?.[0]?.body).not.toContain("Ava");
    expect(channel?.[0]?.body).not.toContain("replied to Sam");
  });

  it("the Feed post keeps the home copy", async () => {
    const { svc, inserted } = service({
      settings: settingsOn,
      channelSurfaces: () => ["imessage:me"],
      catchUp: catchUp({
        morning: (surface) => ({
          lines: [{ text: surface === "channel" ? "chan" : "home", title: "x" }],
        }),
      }),
    });
    await svc.run("morning");
    expect(inserted[0]?.bodyMd).toContain("home");
    expect(inserted[0]?.bodyMd).not.toContain("chan");
  });
});

describe("the due-soon notification", () => {
  const evening = (svc: DailyService) => svc.jobs()[1]?.run({ prompt: "" } as never);
  const morning = (svc: DailyService) => svc.jobs()[0]?.run({ prompt: "" } as never);
  const noticeOf = (mode: string) => ({
    title: mode === "wrapup" ? "Due soon" : "Due today",
    body: "2 assignments due tomorrow: Lecture Work 7, Q3 deck.",
    route: "/memory?kind=due",
    dedupeKey: `memory-due:${mode}:2026-10-28`,
  });

  it("is sent after the wrap-up, and after the morning brief for the day-of switch", async () => {
    const notice = vi.fn((mode: "wrapup" | "dayOf") => noticeOf(mode));
    const { svc, notify } = service({ catchUp: catchUp({ notice }) });
    await evening(svc);
    await morning(svc);
    expect(notice.mock.calls.map((c) => c[0])).toEqual(["wrapup", "dayOf"]);
    const due = (notify.mock.calls as unknown as { title: string; dedupeKey?: string }[][])
      .map((c) => c[0])
      .filter((c) => c?.dedupeKey?.startsWith("memory-due"));
    expect(due.map((d) => d?.title)).toEqual(["Due soon", "Due today"]);
    expect(due[0]).toMatchObject({ kind: "briefing", route: "/memory?kind=due" });
  });

  it("sends nothing when work memory is off or there is nothing to say", async () => {
    const notice = vi.fn(() => undefined);
    const off = service({ catchUp: catchUp({ enabled: () => false, notice }) });
    await evening(off.svc);
    expect(notice).not.toHaveBeenCalled();
    const quiet = service({ catchUp: catchUp({ notice }) });
    await evening(quiet.svc);
    const sent = quiet.notify.mock.calls as unknown as { dedupeKey?: string }[][];
    expect(sent.some((c) => c[0]?.dedupeKey?.startsWith("memory-due") === true)).toBe(false);
  });
});
