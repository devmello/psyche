import { describe, expect, it } from "vitest";
import { effectiveSideEffect, inferApprovalKind, isDeviceOnly } from "../src/index.ts";
import { CTX, call, makeBroker } from "./helpers.ts";

/**
 * The agent writing its own skills (`skill_create` / `skill_update` / `skill_delete`): always a
 * device-only `skill_install` card offering `once`, tainted or not, in any registry declaration.
 */
describe("agent skill authoring tools", () => {
  const tools = ["skill_create", "skill_update", "skill_delete"];

  it("classifies as a destructive, device-only skill_install even if declared as a read", () => {
    for (const t of tools) {
      expect(inferApprovalKind(t)).toBe("skill_install");
      expect(effectiveSideEffect(t, "read")).toBe("destructive");
      expect(isDeviceOnly("skill_install", "destructive")).toBe(true);
    }
  });

  it("asks with once only, untainted and tainted, and never auto-allows", async () => {
    for (const taint of [false, true]) {
      for (const t of tools) {
        const h = makeBroker();
        const d = await h.broker.decide(
          call(t, "destructive", undefined, { kind: "skill_install" }),
          {
            ...CTX,
            taint,
            ...(taint
              ? { taintSources: [{ sourceKind: "browser", origin: "https://x.example" }] }
              : {}),
          },
        );
        expect(d.decision).toBe("ask");
        expect(d.approvalKind).toBe("skill_install");
        expect(d.scopesOffered).toEqual(["once"]);
      }
    }
  });
});
