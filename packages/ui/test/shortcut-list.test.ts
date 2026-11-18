import { describe, expect, it } from "vitest";
import { SHORTCUTS } from "../src/shell/shortcuts.ts";

describe("Shortcut list only holds shortcuts that do something", () => {
  it("does not list the ⌘; fork-selection shortcut, which had no handler", () => {
    expect(SHORTCUTS.map((s) => s.id)).not.toContain("forkSelection");
  });
});
