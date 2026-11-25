import { describe, expect, it } from "vitest";
import { eventScope } from "../src/event-bus.ts";

describe("promise.updated fan-out", () => {
  it("is admin-only until the remote-viewer scrub (W5) lands", () => {
    expect(eventScope("promise.updated")).toBe("operator.admin");
  });

  it("leaves the generic loop event on its usual scope (positive control)", () => {
    expect(eventScope("memory.loop.updated")).toBe("operator.read");
  });
});
