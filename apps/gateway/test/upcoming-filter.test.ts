import type { Automation, UpcomingItem } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { PAUSED_ROUTINES_KEY } from "../src/compose/scheduled.ts";
import { type RunnableUpcomingDeps, runnableUpcoming } from "../src/compose/upcoming-filter.ts";

/** Home's "Coming up" lists only what will really run. */

const marker = (job: string, arg: string) => `[psyche:${job} ${arg}]`;

type Row = Automation & { system: boolean };

function auto(id: string, title: string, prompt: string, system = true): Row {
  return { id, title, prompt, kind: "cron", system, enabled: true } as unknown as Row;
}

const ALL: Row[] = [
  auto("brief", "Daily brief", marker("feed-brief", "daily")),
  auto("mail", "Check for new mail", marker("mail-watch", "poll")),
  auto("digest", "Mail digest", marker("mail-digest", "daily")),
  auto("mine", "Ideas: nightly mining", marker("ideas-mine", "nightly")),
  auto("deliver", "Ideas: delivery window", marker("ideas-deliver", "nightly")),
  auto("goal", "Goal check-in", marker("goal-checkin", "daily")),
  auto("own", "Water the plants", "Remind me to water the plants", false),
];

const item = (a: Automation): UpcomingItem => ({
  kind: "automation",
  id: a.id,
  automationId: a.id,
  title: a.title,
  nextRunAt: "2026-10-19T07:00:00.000Z",
  enabled: true,
});

function deps(
  over: Partial<RunnableUpcomingDeps & { paused: string[] }> = {},
): RunnableUpcomingDeps {
  const kv = new Map<string, unknown>([[PAUSED_ROUTINES_KEY, over.paused ?? []]]);
  return {
    list: async () => ALL,
    systemIds: () => new Set(ALL.filter((a) => a.system).map((a) => a.id)),
    kv: { get: (k) => kv.get(k), set: (k, v) => void kv.set(k, v) },
    setting: () => true,
    mailConnected: () => true,
    mailListening: async () => true,
    ideaSources: async () => true,
    ...over,
  };
}

const titles = async (d: RunnableUpcomingDeps) =>
  (await runnableUpcoming(ALL.map(item), d)).map((i) => i.title);

describe("runnableUpcoming", () => {
  it("lists everything when every routine has what it needs (positive control)", async () => {
    expect(await titles(deps())).toEqual(ALL.map((a) => a.title));
  });

  it("hides the daily brief while the Morning brief switch is off", async () => {
    const t = await titles(deps({ setting: (k) => (k === "daily.brief.enabled" ? false : true) }));
    expect(t).not.toContain("Daily brief");
    expect(t).toContain("Goal check-in");
  });

  it("hides the mail check with no mail connected, or with nothing listening", async () => {
    expect(await titles(deps({ mailConnected: () => false }))).not.toContain("Check for new mail");
    expect(await titles(deps({ mailListening: async () => false }))).not.toContain(
      "Check for new mail",
    );
    // Without mail the digest goes too; with mail connected but nobody listening it stays.
    expect(await titles(deps({ mailConnected: () => false }))).not.toContain("Mail digest");
    expect(await titles(deps({ mailListening: async () => false }))).toContain("Mail digest");
  });

  it("hides Ideas mining and delivery with no sources", async () => {
    const t = await titles(deps({ ideaSources: async () => false }));
    expect(t).not.toContain("Ideas: nightly mining");
    expect(t).not.toContain("Ideas: delivery window");
  });

  it("hides a paused routine, and never hides the owner's own automations", async () => {
    const t = await titles(
      deps({
        paused: ["goal-checkin:daily"],
        setting: () => false,
        mailConnected: () => false,
        ideaSources: async () => false,
      }),
    );
    expect(t).toEqual(["Water the plants"]);
  });

  it("a failing check keeps the row rather than hiding the schedule", async () => {
    const t = await titles(
      deps({
        ideaSources: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(t).toContain("Ideas: nightly mining");
  });
});
