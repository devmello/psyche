import { describe, expect, it } from "vitest";
import { parseIsoDuration, parseSchedule } from "../src/index.ts";
import { BASE, setup } from "./helpers.ts";

const iso = (t: number) => new Date(t).toISOString();
const ny = (expr: string) => parseSchedule("cron", expr, "America/New_York");

describe("schedules", () => {
  it("cron across the spring-forward DST change fires once a day, at the next valid time", () => {
    // 2027-03-14 02:30 does not exist in New York; the run happens at 03:30 EDT that day.
    const s = ny("30 2 * * *");
    const out: string[] = [];
    let t = Date.parse("2027-03-12T12:00:00Z");
    for (let i = 0; i < 4; i += 1) {
      t = s.next(t) as number;
      out.push(iso(t));
    }
    expect(out).toEqual([
      "2027-03-13T07:30:00.000Z", // 02:30 EST
      "2027-03-14T07:30:00.000Z", // 03:30 EDT (02:30 skipped by the clock)
      "2027-03-15T06:30:00.000Z", // 02:30 EDT
      "2027-03-16T06:30:00.000Z",
    ]);
  });

  it("cron across the fall-back DST change does not fire the repeated hour twice", () => {
    // 2026-11-01 01:30 happens twice in New York (EDT, then EST); the job runs once.
    const s = ny("30 1 * * *");
    const out: string[] = [];
    let t = Date.parse("2026-10-31T12:00:00Z");
    for (let i = 0; i < 3; i += 1) {
      t = s.next(t) as number;
      out.push(iso(t));
    }
    expect(out).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
      "2026-11-03T06:30:00.000Z",
    ]);
  });

  it("a weekday 7am brief follows local time across the UK change", () => {
    const s = parseSchedule("briefing", "0 7 * * 1-5", "Europe/London");
    expect(iso(s.next(Date.parse("2026-10-22T12:00:00Z")) as number)).toBe(
      "2026-10-23T06:00:00.000Z", // Friday, BST
    );
    expect(iso(s.next(Date.parse("2026-10-23T12:00:00Z")) as number)).toBe(
      "2026-10-26T07:00:00.000Z", // Monday, GMT
    );
  });

  it("durations, one-shots and bad input", () => {
    expect(parseIsoDuration("PT30M")).toBe(1_800_000);
    expect(parseIsoDuration("P1W")).toBe(7 * 86_400_000);
    expect(parseIsoDuration("PT")).toBeUndefined();
    const once = parseSchedule("reminder", "2026-10-20T07:00:00Z", "UTC");
    expect(once.next(0)).toBe(Date.parse("2026-10-20T07:00:00Z"));
    expect(once.next(Date.parse("2026-10-21T00:00:00Z"))).toBeUndefined();
    expect(() => parseSchedule("cron", "0 7 * *", "UTC")).toThrow(/5 fields/);
    expect(() => parseSchedule("cron", "0 7 * * *", "Mars/Olympus")).toThrow(/timezone/);
    expect(() => parseSchedule("interval", "PT10S", "UTC")).toThrow(/one minute/);
    expect(() => parseSchedule("watch", "0 * * * *", "UTC")).toThrow(/duration/);
    expect(() => parseSchedule("reminder", "tomorrow", "UTC")).toThrow(/instant/);
  });

  it("nextRuns lists fire times in the automation's timezone", async () => {
    const { scheduler } = setup({ start: Date.parse("2026-10-19T00:00:00Z") });
    const a = await scheduler.create({
      ...BASE,
      kind: "cron",
      schedule: "0 9 * * *",
      timezone: "Asia/Tokyo",
    });
    // Created exactly at 09:00 Tokyo: the next run is strictly later.
    expect(a.nextRunAt).toBe("2026-10-20T00:00:00.000Z");
    expect((await scheduler.nextRuns(a.id, 2)).map(iso)).toEqual([
      "2026-10-20T00:00:00.000Z",
      "2026-10-21T00:00:00.000Z",
    ]);
  });
});
