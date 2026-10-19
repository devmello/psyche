import { describe, expect, it } from "vitest";
import { highlightTokens, languageFor } from "../src/core/code.ts";

describe("code highlighting", () => {
  it("maps file names to languages", () => {
    expect(languageFor("src/main.ts")).toBe("typescript");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("notes.txt")).toBe("text");
  });

  it("returns colored tokens with source offsets", async () => {
    const code = "const x = 1;\n// note\n";
    const tokens = await highlightTokens(code, "typescript");
    expect(tokens.length).toBeGreaterThan(3);
    const kw = tokens.find((t) => code.slice(t.from, t.to) === "const");
    expect(kw?.color).toMatch(/^#/);
    const comment = tokens.find((t) => code.slice(t.from, t.to).includes("note"));
    expect(comment).toBeDefined();
    expect(await highlightTokens(code, "text")).toEqual([]);
    expect(await highlightTokens(code, "no-such-lang")).toEqual([]);
  });
});
