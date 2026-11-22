import { describe, expect, it } from "vitest";
import { otherSurfacesFor } from "../src/blocks/approval-surfaces.ts";

describe("otherSurfacesFor", () => {
  it("hides the desktop, the web and every paired device's own surface", () => {
    expect(
      otherSurfacesFor(["desktop", "web", "notification", "device:phone-1", "device:phone:2"]),
    ).toEqual(["notification"]);
  });

  it("keeps chat surfaces, and names nothing when only hidden ones remain", () => {
    expect(otherSurfacesFor(["desktop", "telegram:42", "device:a"])).toEqual(["telegram:42"]);
    expect(otherSurfacesFor(["desktop", "web", "device:a"])).toEqual([]);
  });

  it("can hide a different set (the card already on screen)", () => {
    expect(otherSurfacesFor(["desktop", "notification"], ["notification"])).toEqual(["desktop"]);
  });
});
