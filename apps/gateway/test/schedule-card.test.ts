import type { ApprovalRequestInput, PermissionBroker } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  SCHEDULE_WORDS,
  scheduleSummary,
  scheduleWords,
  withScheduleCard,
} from "../src/compose/schedule-card.ts";

// Wednesday 2026-11-25 10:00 in Los Angeles (18:00 UTC).
const NOW = Date.parse("2026-11-25T18:00:00Z");
const TZ = "America/Los_Angeles";
const en = { now: NOW, language: "en", locale: "en-US" } as const;
const cron = (schedule: string) => ({ title: "x", kind: "cron", schedule, timezone: TZ });

describe("schedule words", () => {
  const cases: [string, ReturnType<typeof cron>, string][] = [
    ["one-off tomorrow", cron("0 9 26 11 *"), "tomorrow at 9:00 AM"],
    ["one-off today", cron("30 15 25 11 *"), "today at 3:30 PM"],
    ["one-off later", cron("0 9 3 12 *"), "Thursday, December 3 at 9:00 AM"],
    ["daily", cron("0 7 * * *"), "Every day at 7:00 AM"],
    ["weekdays", cron("0 9 * * 1-5"), "Every weekday at 9:00 AM"],
    ["weekdays listed", cron("0 9 * * 1,2,3,4,5"), "Every weekday at 9:00 AM"],
    ["weekly", cron("30 18 * * 5"), "Every Friday at 6:30 PM"],
    ["weekly several", cron("0 8 * * 1,3"), "Every Monday and Wednesday at 8:00 AM"],
    ["weekly sunday as 7", cron("0 8 * * 7"), "Every Sunday at 8:00 AM"],
    ["monthly", cron("0 9 1 * *"), "On day 1 of every month at 9:00 AM"],
    ["odd: steps", cron("*/5 * * * *"), "On a schedule"],
    ["odd: hour list", cron("0 9,17 * * *"), "On a schedule"],
    ["odd: day and weekday", cron("0 9 1 * 1"), "On a schedule"],
    ["odd: not a cron", cron("whenever"), "On a schedule"],
    ["interval", { title: "x", kind: "interval", schedule: "PT1H", timezone: TZ }, "On a schedule"],
  ];
  it.each(cases)("%s", (_name, input, words) => {
    expect(scheduleWords(input, en)).toBe(words);
  });

  it("at: today, an offset time and a bare local time", () => {
    const at = (s: string) => scheduleWords({ title: "x", at: s, timezone: TZ }, en);
    expect(at("2026-11-25T23:42:00Z")).toBe("today at 3:42 PM");
    expect(at("2026-11-26T09:00:00")).toBe("tomorrow at 9:00 AM");
    expect(at("later")).toBe("On a schedule");
  });

  it("reads in the owner's language and clock", () => {
    const de = { now: NOW, language: "de", locale: "de-DE" } as const;
    expect(scheduleWords(cron("0 9 * * 1-5"), de)).toBe("Jeden Werktag um 9:00");
    expect(scheduleWords(cron("0 9 26 11 *"), de)).toBe("morgen um 9:00");
  });

  it("every language has every phrase with the same placeholders", () => {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [lang, words] of Object.entries(SCHEDULE_WORDS)) {
      for (const key of Object.keys(SCHEDULE_WORDS.en) as (keyof typeof words)[]) {
        expect(holes(words[key]), `${lang}.${key}`).toEqual(holes(SCHEDULE_WORDS.en[key]));
      }
    }
    expect(Object.keys(SCHEDULE_WORDS)).toHaveLength(11);
  });
});

describe("schedule summary", () => {
  it("a reminder reads as a sentence", () => {
    expect(
      scheduleSummary(
        { title: "Reminder: call the dentist", at: "2026-11-26T09:00:00", timezone: TZ },
        en,
      ),
    ).toBe("Remind you tomorrow at 9:00 AM: call the dentist");
    expect(
      scheduleSummary({ ...cron("0 9 26 11 *"), title: "Reminder: call the dentist" }, en),
    ).toBe("Tomorrow at 9:00 AM: call the dentist");
  });
  it("a recurring run leads with the cadence", () => {
    expect(scheduleSummary({ ...cron("0 9 * * 1-5"), title: "Daily brief" }, en)).toBe(
      "Every weekday at 9:00 AM: Daily brief",
    );
  });
});

describe("the schedule approval card", () => {
  const seen: ApprovalRequestInput[] = [];
  const broker = {
    requestApproval: async (input: ApprovalRequestInput) => {
      seen.push(input);
      return { approval: {} } as never;
    },
    other: () => "kept",
  } as unknown as PermissionBroker;
  const wrapped = withScheduleCard(broker, {
    zone: () => TZ,
    now: () => NOW,
    language: () => "en",
    systemLocale: () => "en-US",
  });
  const request = (details: Record<string, unknown>) =>
    ({ kind: "connector_action", summary: "Schedule", details }) as unknown as ApprovalRequestInput;

  it("has no raw cron in the title and no kind or prompt among the rows", async () => {
    const params = {
      title: "Reminder: call the dentist",
      kind: "cron",
      schedule: "0 9 26 11 *",
      prompt: "Send the owner a notification now: call the dentist",
    };
    await wrapped.requestApproval(request({ tool: "schedule", params }));
    const sent = seen.at(-1) as ApprovalRequestInput;
    expect(sent.summary).toBe("Tomorrow at 9:00 AM: call the dentist");
    expect(sent.summary).not.toMatch(/0 9 26|\*/);
    const d = sent.details as Record<string, unknown>;
    expect(d.params).toEqual({ when: "tomorrow at 9:00 AM" });
    const rows = JSON.stringify(Object.entries(d).filter(([k]) => !k.endsWith("Ref")));
    expect(rows).not.toMatch(/Send the owner|cron|0 9 26/);
    // The raw fields stay for the Details disclosure and the audit.
    expect(d.rawScheduleRef).toContain("0 9 26 11 *");
    expect(d.rawScheduleRef).toContain("Send the owner a notification");
  });

  it("a one-time `at` reads as a reminder", async () => {
    await wrapped.requestApproval(
      request({
        tool: "schedule",
        params: { title: "Reminder: stretch", at: "2026-11-25T23:42:00Z", prompt: "p" },
      }),
    );
    expect((seen.at(-1) as ApprovalRequestInput).summary).toBe(
      "Remind you today at 3:42 PM: stretch",
    );
  });

  it("leaves other tools and other methods alone", async () => {
    const other = request({ tool: "web.fetch", params: { url: "https://example.com" } });
    await wrapped.requestApproval(other);
    expect(seen.at(-1)).toBe(other);
    expect((wrapped as unknown as { other: () => string }).other()).toBe("kept");
  });
});
