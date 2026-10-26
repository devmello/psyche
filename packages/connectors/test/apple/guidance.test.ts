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
});
