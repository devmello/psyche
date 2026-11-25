import { describe, expect, it } from "vitest";
import { eventScope, SCRUBBED_EVENTS } from "../src/event-bus.ts";

describe("promise.updated fan-out", () => {
  it("is operator.read now that each subscriber gets its own scrubbed form (W5)", () => {
    expect(eventScope("promise.updated")).toBe("operator.read");
  });

  it("is never sent as the shared frame: it is personalised per subscriber", () => {
    expect(SCRUBBED_EVENTS.has("promise.updated")).toBe(true);
    expect(SCRUBBED_EVENTS.has("memory.loop.updated")).toBe(true);
  });

  it("leaves the generic loop event on its usual scope (positive control)", () => {
    expect(eventScope("memory.loop.updated")).toBe("operator.read");
  });
});
