import { readFileSync } from "node:fs";
import { resolveAppRoute } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { blocks, call, harness, resultsIn, runTurn, say, spec, toolStatuses } from "./harness.ts";

const GUIDE = readFileSync(
  new URL("../../../skills/psyche-app-guide/SKILL.md", import.meta.url),
  "utf8",
);

/** The app guide skill and `app_navigate`: explain where it is, then offer to open it. */

describe("resolveAppRoute", () => {
  it("accepts known screens, Settings sections and Library sections", () => {
    for (const r of [
      "/chat",
      "/feed",
      "/can-do",
      "/overview",
      "/settings/daily",
      "/settings/computer-use",
      "/settings/connectors/add-mcp",
      "/library/artifacts",
      "/agent/approvals",
    ]) {
      expect(resolveAppRoute(r)).toBe(r);
    }
    expect(resolveAppRoute("/library")).toBe("/library/documents");
    expect(resolveAppRoute("/settings")).toBe("/settings/model");
  });

  it("refuses anything else, so the model cannot carry data into the UI", () => {
    for (const r of [
      "",
      "settings/daily",
      "https://evil.test",
      "//evil.test",
      "/settings/nope",
      "/settings/daily/extra",
      "/settings/daily?x=1",
      "/chat/thr_1",
      "/feed#x",
      "/window/settings/model",
      "/overview/run/abc",
      "/library/secrets",
    ]) {
      expect(resolveAppRoute(r), r).toBeNull();
    }
  });
});

describe("app_navigate", () => {
  it("shows a button block and needs no approval", async () => {
    const h = harness({
      script: [call("n1", "app_navigate", { route: "/settings/daily" }), say("Here.")],
    });
    const events = await runTurn(h, "open the daily settings");
    expect(blocks(events).filter((b) => b.type === "app_link")).toEqual([
      { type: "app_link", route: "/settings/daily" },
    ]);
    expect(toolStatuses(events, "n1")).toContain("ok");
    expect(h.broker.issued).toHaveLength(0);
  });

  it("rejects a route that is not an app screen and shows nothing", async () => {
    const h = harness({
      script: [call("n1", "app_navigate", { route: "https://evil.test/settings" }), say("No.")],
    });
    const events = await runTurn(h, "open it");
    expect(blocks(events).some((b) => b.type === "app_link")).toBe(false);
    expect(toolStatuses(events, "n1")).toContain("failed");
  });
});

describe('"how do I set the brief time?" with a mocked model', () => {
  it("reads the guide, answers with the exact path and offers to open Settings → Daily", async () => {
    const h = harness({
      script: [
        call("g1", "skills_read", { name: "psyche-app-guide" }),
        call("n1", "app_navigate", { route: "/settings/daily" }),
        say("Settings → Daily → Morning brief → Time. I've put a button below to open it."),
      ],
    });
    h.loop.registry.register({
      spec: spec("skills_read", "none"),
      execute: async () => ({ output: { content: GUIDE }, provenance: "trusted" as const }),
    });
    const events = await runTurn(h, "how do I set the brief time?");

    // The model saw the guide, and the guide holds the answer and the route to offer.
    const seen = JSON.stringify(resultsIn(h.provider.requests[1]).get("g1")?.output ?? "");
    expect(seen).toContain("Settings → Daily → Morning brief → Time");
    expect(seen).toContain("/settings/daily");
    // The offer is a button for that route.
    expect(blocks(events)).toContainEqual({ type: "app_link", route: "/settings/daily" });
    expect(h.broker.issued).toHaveLength(0);
  });
});
