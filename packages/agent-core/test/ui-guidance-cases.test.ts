import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("render_ui eval cases", () => {
  const { cases } = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "ui-vs-text-cases.json"), "utf8"),
  ) as { cases: Array<{ prompt: string; expect: string; why: string }> };

  it("is well formed and balanced: text is the right answer about as often as UI", () => {
    expect(
      cases.every((c) => c.prompt && c.why && ["ui", "text", "update_ui"].includes(c.expect)),
    ).toBe(true);
    const text = cases.filter((c) => c.expect === "text").length;
    const ui = cases.filter((c) => c.expect !== "text").length;
    expect(text).toBeGreaterThanOrEqual(ui - 1);
    expect(cases.some((c) => /approv/i.test(c.prompt) && c.expect === "text")).toBe(true);
  });
});
