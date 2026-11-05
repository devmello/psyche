import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_GUIDANCE, guidanceSection } from "../../src/index.ts";

/** #639: the per-app guidance is the text P wrote in docs/connectors/agent-guidance.md. */

describe("per-app guidance", () => {
  it("matches docs/connectors/agent-guidance.md exactly", () => {
    const doc = readFileSync(
      new URL("../../../../docs/connectors/agent-guidance.md", import.meta.url),
      "utf8",
    );
    const fromDoc = Object.fromEntries(
      [...doc.matchAll(/## `([^`]+)`\n\n- For: (.*)\n- Prefer: (.*)\n- Never: (.*)\n/g)].map(
        (m) => [m[1], { for: m[2], prefer: m[3], never: m[4] }],
      ),
    );
    expect(Object.keys(fromDoc).length).toBeGreaterThan(5);
    expect(APP_GUIDANCE).toEqual(fromDoc);
  });

  it("renders one line per connected app with guidance, in a stable order", () => {
    const text = guidanceSection(
      ["apple:mail", "google", "apple:calendar", "apple:mail"],
      (t) => t,
    );
    expect(text?.split("\n").map((l) => l.split(":").slice(0, 2).join(":"))).toEqual([
      "apple:calendar",
      "apple:mail",
    ]);
    expect(text).toContain("Never: claim to invite people");
    expect(guidanceSection(["google"], (t) => t)).toBeUndefined();
  });

  it("speaks of Outlook and this PC on a Windows Host, and has nothing for the Mac-only apps", () => {
    const types = ["apple:mail", "apple:reminders", "apple:calendar", "apple:contacts"];
    const text = guidanceSection(
      [...types, "apple:notes", "things", "obsidian"],
      (t) => t,
      "windows",
    );
    const lines = text?.split("\n") ?? [];
    expect(lines.map((l) => l.split(": For:")[0])).toEqual([
      "apple:calendar",
      "apple:contacts",
      "apple:mail",
      "apple:reminders",
      "obsidian",
    ]);
    expect(text).not.toMatch(/Mac|message:\/\/|EventKit|Reminders app|Trash/);
    expect(text).toContain("Outlook");
    expect(text).toContain("three email addresses");
    expect(guidanceSection(["chrome:tabs"], (t) => t, "windows")).toContain("Edge");
    // Microsoft 365 (with To Do) reads the same on both.
    for (const platform of ["macos", "windows"] as const)
      expect(guidanceSection(["microsoft"], (t) => t, platform)).toContain(
        "`reminders_list_lists`",
      );
  });
});
