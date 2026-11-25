import { describe, expect, it } from "vitest";
import { isHostHelperCapabilityReachable, isUnreachableCapability } from "../src/handlers/nodes.ts";

/**
 * Psyche points (docs/design/psyche-points-2026.md §4.3.5): the helper's `points.*` capabilities
 * are reachable only through the Gateway's own Points module, never through `nodes.invoke` on any
 * node or by an agent tool.
 */
describe("points.* is unreachable through nodes.invoke", () => {
  it.each([
    "points.windows",
    "points.session",
    "points.show",
    "points.look",
    "points.end",
    "points",
    "POINTS.show",
    "points:show",
  ])("%s is unreachable, on a Host helper and on any other node", (name) => {
    expect(isUnreachableCapability(name)).toBe(true);
    expect(isHostHelperCapabilityReachable(name)).toBe(false);
  });

  it("positive control: the same checks let an ordinary capability through, and pointsy names stay", () => {
    expect(isUnreachableCapability("system.echo")).toBe(false);
    // A capability that only starts with the same letters is not the family.
    expect(isUnreachableCapability("pointsofinterest.list")).toBe(false);
  });
});
