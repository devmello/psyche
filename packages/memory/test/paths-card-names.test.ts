import { describe, expect, it } from "vitest";
import { normalizeWorkspacePath } from "../src/paths.ts";

// Assembled at runtime so the repo secret scans never match a tracked line (a Luhn-valid test PAN).
const j = (...parts: string[]) => parts.join("");
const PAN = j("4111", "1111", "1111", "1111");

describe("workspace file names refuse card numbers", () => {
  it.each([
    ["bare card as the name", `${PAN}.md`],
    ["card in a folder name", `notes/${PAN}/todo.md`],
    ["card with spaces", `${j("4111", " ", "1111", " ", "1111", " ", "1111")}.md`],
    ["card with dashes", `${j("4111", "-", "1111", "-", "1111", "-", "1111")}.txt`],
  ])("refuses %s", (_name, path) => {
    expect(() => normalizeWorkspacePath(path)).toThrow(/card numbers/);
  });

  it("accepts an ordinary hex-named file", () => {
    const hex = j("ab", PAN, "cd", "9f".repeat(22));
    expect(() => normalizeWorkspacePath(`keys/${hex}.md`)).not.toThrow();
  });
});
