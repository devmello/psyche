import { describe, expect, it } from "vitest";
import { effectiveSideEffect } from "../src/kinds.ts";

/** The agent's `connector_*` tools: running or deleting its own code never classes below destructive. */
describe("connector_* tool floors", () => {
  it("floors connector_test and connector_remove at destructive", () => {
    expect(effectiveSideEffect("connector_test", "write")).toBe("destructive");
    expect(effectiveSideEffect("connector_remove", "none")).toBe("destructive");
  });
  it("leaves the inert file tools as declared", () => {
    expect(effectiveSideEffect("connector_write_file", "none")).toBe("none");
  });
});
