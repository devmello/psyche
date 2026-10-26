import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * docs/connectors/agent-guidance.md is parsed by the Gateway (apple-apps-2026 §7.3): one
 * `## \`<connector id>\`` heading per app, then exactly the three lines For / Prefer / Never.
 */

const DOC = fileURLToPath(new URL("../../../docs/connectors/agent-guidance.md", import.meta.url));

function sections(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let id: string | undefined;
  for (const line of readFileSync(DOC, "utf8").split("\n")) {
    const h = /^## `([a-z]+(?::[a-z]+)?)`$/.exec(line);
    if (h) {
      id = h[1] as string;
      out.set(id, []);
    } else if (id !== undefined && line.startsWith("- ")) out.get(id)?.push(line.slice(2));
  }
  return out;
}

describe("per-app agent guidance", () => {
  it("has three short lines, For / Prefer / Never, for every connected app", () => {
    const all = sections();
    expect([...all.keys()]).toEqual(
      expect.arrayContaining([
        "apple:mail",
        "apple:reminders",
        "apple:calendar",
        "apple:notes",
        "apple:contacts",
        "apple:music",
        "apple:safari",
        "chrome:tabs",
        "apple:files",
        "apple:shortcuts",
        "things",
        "obsidian",
      ]),
    );
    for (const [id, lines] of all) {
      expect(
        lines.map((l) => l.split(":")[0]),
        id,
      ).toEqual(["For", "Prefer", "Never"]);
      for (const l of lines) expect(l.length, `${id}: ${l}`).toBeLessThanOrEqual(220);
    }
  });

  it("says that EventKit cannot invite attendees", () => {
    expect(sections().get("apple:calendar")?.[2]).toContain("EventKit cannot add attendees");
  });
});
