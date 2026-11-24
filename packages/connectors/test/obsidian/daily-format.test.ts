import { describe, expect, it } from "vitest";
import {
  dailyNoteName,
  formatDailyName,
  localDay,
  renderDailyTemplate,
} from "../../src/obsidian/daily-format.ts";

/** Obsidian's Daily notes format (#639 follow-up): moment.js tokens, English names, en weeks. */

// 2026-10-22 is a Thursday, day 295 of the year, in week 43 (Sunday first, week 1 holds 1 January).
const THU = "2026-10-22";
// 2026-10-01 is a Thursday (the 1st); 2026-10-13 is a Tuesday (the 13th).
const FIRST = "2026-10-01";
const THIRTEENTH = "2026-10-13";

describe("formatDailyName (moment.js tokens)", () => {
  it.each([
    ["YYYY-MM-DD", THU, "2026-10-22"],
    ["YYYY/MM/YYYY-MM-DD", THU, "2026/10/2026-10-22"],
    ["DD-MM-YYYY", THU, "22-10-2026"],
    ["dddd, MMMM D, YYYY", THU, "Thursday, October 22, 2026"],
    ["ddd MMM D YY", THU, "Thu Oct 22 26"],
    ["dd d DDDD DDD", THU, "Th 4 295 295"],
    ["YYYY-[W]ww", THU, "2026-W43"],
    ["gggg-w", THU, "2026-43"],
    ["[Journal] YYYY-MM-DD", THU, "Journal 2026-10-22"],
    ["Do MMMM YYYY", THU, "22nd October 2026"],
    ["Do MMMM YYYY", FIRST, "1st October 2026"],
    ["Do MMMM YYYY", THIRTEENTH, "13th October 2026"],
    ["YYYY-M-D", "2026-01-05", "2026-1-5"],
    ["YYYY/MM/DD/YYYY-MM-DD", THU, "2026/10/22/2026-10-22"],
    ["YY-MMM-DDDD", FIRST, "26-Oct-274"],
    ["gggg-ww", "2025-12-31", "2026-01"],
  ])("%s on %s is %s", (format, date, expected) => {
    expect(formatDailyName(date, format)).toBe(expected);
  });

  it.each([
    ["HH-mm", "unknown token HH"],
    ["YYYY-Q", "unknown token Q"],
    ["[Journal YYYY", "unclosed bracket"],
  ])("returns null for %s (%s)", (format) => {
    expect(formatDailyName(THU, format)).toBeNull();
  });

  it("rejects a date that does not exist", () => {
    expect(formatDailyName("2026-02-31", "YYYY")).toBeNull();
  });
});

describe("dailyNoteName (path, with fallback)", () => {
  it.each([
    ["YYYY/MM/YYYY-MM-DD", "2026/10/2026-10-22"],
    ["[Journal] YYYY-MM-DD", "Journal 2026-10-22"],
    ["HH-mm", "2026-10-22"],
    ["../YYYY", "2026-10-22"],
    ["/YYYY-MM-DD", "2026-10-22"],
    ["YYYY//MM", "2026-10-22"],
    [".obsidian/YYYY", "2026-10-22"],
    ["YYYY:MM-DD", "2026-10-22"],
    ["", "2026-10-22"],
    [undefined, "2026-10-22"],
    [42, "2026-10-22"],
  ])("format %j names %s", (format, expected) => {
    expect(dailyNoteName(THU, format)).toBe(expected);
  });
});

describe("renderDailyTemplate", () => {
  const now = new Date(2026, 9, 22, 9, 5);

  it("replaces date, date with a format, and title; leaves other text alone", () => {
    const tpl = "# {{title}}\nDate: {{date:dddd}}, {{date}}\nDay: {{ date:DD.MM.YYYY }}\n{{foo}}\n";
    expect(renderDailyTemplate(tpl, THU, "2026-10-22", now)).toBe(
      "# 2026-10-22\nDate: Thursday, 2026-10-22\nDay: 22.10.2026\n{{foo}}\n",
    );
  });

  it("fills {{time}} as local HH:mm", () => {
    expect(renderDailyTemplate("at {{time}}", THU, "t", now)).toBe("at 09:05");
  });
});

describe("localDay", () => {
  it("is the calendar date on the machine's clock, not UTC", () => {
    expect(localDay(new Date(2026, 9, 22, 23, 30))).toBe("2026-10-22");
    expect(localDay(new Date(2026, 0, 3, 0, 15))).toBe("2026-01-03");
  });
});
