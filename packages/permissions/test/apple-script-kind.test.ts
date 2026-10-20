import { describe, expect, it } from "vitest";
import { AUTH_KINDS, allowedScopes, DEVICE_ONLY_KINDS } from "../src/index.ts";

/** #268: a script runs with the owner's Automation grant, so it is approved like exec_host. */
describe("apple_script approvals (#268)", () => {
  it("are device-only, need authentication and are once-only", () => {
    expect(DEVICE_ONLY_KINDS).toContain("apple_script");
    expect(AUTH_KINDS).toContain("apple_script");
    expect(allowedScopes("destructive", "apple_script")).toEqual(["once"]);
  });
});
