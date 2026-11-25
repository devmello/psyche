import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Methods } from "../src/index.ts";

// @ts-expect-error plain .mjs script without types
const gen = (await import("../../../.claude/scripts/gen-ios-side-effecting.mjs")) as {
  OUTPUT: string;
  render: () => string;
};

describe("iOS side-effecting method list", () => {
  it("apps/ios/Tests/side-effecting-methods.json is fresh (run `node .claude/scripts/gen-ios-side-effecting.mjs`)", () => {
    expect(readFileSync(gen.OUTPUT, "utf8")).toBe(gen.render());
  });

  it("matches the method registry", () => {
    const fromRegistry = Object.entries(Methods)
      .filter(([, spec]) => (spec as { sideEffecting?: boolean }).sideEffecting === true)
      .map(([name]) => name)
      .sort();
    expect(JSON.parse(readFileSync(gen.OUTPUT, "utf8"))).toEqual(fromRegistry);
    expect(fromRegistry).toContain("goals.update");
  });
});
