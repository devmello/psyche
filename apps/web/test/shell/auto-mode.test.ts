import { describe, expect, it } from "vitest";
import { autoModeBlockedBy } from "../../src/shell/auto-mode.ts";

const listed = {
  providers: [
    {
      models: [
        { ref: "anthropic/claude-sonnet-5-5", autoMode: true },
        { ref: "lmstudio/tiny-7b", autoMode: false },
        { ref: "ollama/unknown" },
      ],
    },
  ],
  roles: { primary: "lmstudio/tiny-7b" },
};

describe("autoModeBlockedBy", () => {
  it("judges an unpinned thread by the primary role's model", () => {
    expect(autoModeBlockedBy(listed, null)).toBe("lmstudio/tiny-7b");
    expect(
      autoModeBlockedBy({ ...listed, roles: { primary: "anthropic/claude-sonnet-5-5" } }, null),
    ).toBeNull();
  });

  it("judges a pinned thread by its own model", () => {
    expect(autoModeBlockedBy(listed, "anthropic/claude-sonnet-5-5")).toBeNull();
    expect(autoModeBlockedBy(listed, "lmstudio/tiny-7b")).toBe("lmstudio/tiny-7b");
  });

  it("leaves unknown models and older Gateways to the Gateway", () => {
    expect(autoModeBlockedBy(listed, "ollama/unknown")).toBeNull();
    expect(autoModeBlockedBy(listed, "x/not-listed")).toBeNull();
    expect(autoModeBlockedBy(undefined, null)).toBeNull();
  });
});
