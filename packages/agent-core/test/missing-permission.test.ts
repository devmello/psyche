import { type DecisionContext, PsycheError, type ToolCallIntent } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { missingOf } from "../src/index.ts";
import { call, harness, resultsIn, runTurn, say, spec } from "./harness.ts";

/**
 * Missing permissions reach the model (security §3.13): a broker denial that names one, and a
 * tool error whose `details.missing` names one, carry it with the request_permission hint.
 */

describe("missing permissions", () => {
  it("a broker denial carries the missing permission and the request_permission hint", async () => {
    const h = harness();
    const decide = h.broker.decide.bind(h.broker);
    h.broker.decide = async (c: ToolCallIntent, ctx: DecisionContext) =>
      c.tool === "exec_host"
        ? {
            decision: "deny",
            rule: "exec_host:disabled",
            reason: "exec_host is off",
            missing: { need: "capability", capability: "exec_host" },
          }
        : decide(c, ctx);
    h.loop.registry.register({
      spec: spec("exec_host", "write"),
      execute: async () => ({ output: {}, provenance: "trusted" }),
    });
    h.provider.script([call("x1", "exec_host", { argv: ["ls"] }), say("Asked.")]);
    await runTurn(h, "list my project");
    const out = JSON.stringify(resultsIn(h.provider.requests.at(-1)).get("x1")?.output);
    expect(out).toContain("exec_host is off");
    expect(out).toContain('{\\"need\\":\\"capability\\",\\"capability\\":\\"exec_host\\"}');
    expect(out).toContain("request_permission");
  });

  it("a tool error with details.missing is passed to the model with the hint", async () => {
    const h = harness();
    h.loop.registry.register({
      spec: spec("read_file", "read"),
      execute: async () => ({ output: {}, provenance: "trusted" }),
      run: async () => {
        throw new PsycheError("forbidden", "/x is outside every granted folder", {
          details: { missing: { need: "folder", path: "/x", access: "read" } },
        });
      },
    });
    h.provider.script([call("r1", "read_file", { path: "/x/a" }), say("Asked.")]);
    await runTurn(h, "read /x/a");
    const result = resultsIn(h.provider.requests.at(-1)).get("r1");
    expect(result?.isError).toBe(true);
    expect(result?.output).toMatchObject({
      missing: { need: "folder", path: "/x", access: "read" },
      hint: expect.stringContaining("request_permission"),
    });
  });

  it("ignores malformed details.missing", () => {
    const bad = new PsycheError("forbidden", "no", { details: { missing: { need: "root" } } });
    expect(missingOf(bad)).toBeUndefined();
    expect(missingOf(new Error("plain"))).toBeUndefined();
  });
});
