import { describe, expect, it } from "vitest";
import { APP_TOP_LEVEL_ROUTES, resolveAppRoute } from "../src/app-routes.ts";

describe("the Memory routes", () => {
  it("allows exactly /memory and the reserved /memory/review", () => {
    expect(APP_TOP_LEVEL_ROUTES).toContain("memory");
    expect(resolveAppRoute("/memory")).toBe("/memory");
    expect(resolveAppRoute("/memory/review")).toBe("/memory/review");
  });

  it("takes no ids, queries, hashes or other pages", () => {
    for (const bad of [
      "/memory/other",
      "/memory/review/x",
      "/memory?kind=due",
      "/memory?entity=ent_1",
      "/memory#x",
      "/memory/ent_1",
    ])
      expect(resolveAppRoute(bad), bad).toBeNull();
  });

  it("still opens /people, as Memory", () => {
    expect(APP_TOP_LEVEL_ROUTES).toContain("people");
    expect(resolveAppRoute("/people")).toBe("/memory");
    expect(resolveAppRoute("/people/ent_1")).toBeNull();
    expect(resolveAppRoute("/people?entity=ent_1")).toBeNull();
  });
});
