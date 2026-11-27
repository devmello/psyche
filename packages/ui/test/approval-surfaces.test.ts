import { describe, expect, it } from "vitest";
import { otherSurfacesFor } from "../src/blocks/approval-surfaces.ts";

describe("otherSurfacesFor", () => {
  it("hides the desktop, the off-Mac marker (and a stored legacy web) and every paired device's own surface", () => {
    expect(
      otherSurfacesFor([
        "desktop",
        "offMac",
        "web",
        "notification",
        "device:phone-1",
        "device:phone:2",
      ]),
    ).toEqual(["notification"]);
  });

  it("keeps other surfaces, and names nothing when only hidden ones remain", () => {
    expect(otherSurfacesFor(["desktop", "notification", "device:a"])).toEqual(["notification"]);
    expect(otherSurfacesFor(["desktop", "offMac", "device:a"])).toEqual([]);
  });

  it("can hide a different set (the card already on screen)", () => {
    expect(otherSurfacesFor(["desktop", "notification"], ["notification"])).toEqual(["desktop"]);
  });
});
