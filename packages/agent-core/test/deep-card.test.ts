import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  call,
  endOf,
  harness,
  recorder,
  resultsIn,
  runTurn,
  say,
  spec,
  text,
  toolStatuses,
} from "./harness.ts";

/**
 * The broker never raises a card whose details nest deeper than a card shows (`details_too_deep`,
 * permissions `detailsTooDeep`). That is the call's error, not the run's (owner decision,
 * 2026-11-20): the model gets a tool error and can call again with flatter arguments.
 */

const nest = (n: number): unknown => {
  let v: unknown = "x";
  for (let i = 0; i < n; i += 1) v = { a: v };
  return v;
};
const depth = (v: unknown): number =>
  typeof v === "object" && v !== null ? 1 + Math.max(0, ...Object.values(v).map(depth)) : 0;

/** The broker's refusal, as `requestApproval` throws it. */
function refuseDeep(h: ReturnType<typeof harness>, other?: PsycheError) {
  const orig = h.broker.requestApproval.bind(h.broker);
  h.broker.requestApproval = async (input) => {
    if (depth(input.details) > 16) {
      throw new PsycheError(
        "invalid_params",
        "the approval's details are nested too deeply to show in full",
        { details: { reason: "details_too_deep" } },
      );
    }
    if (other !== undefined) throw other;
    return orig(input);
  };
}

describe("an approval card too deep to show", () => {
  it("is a tool error the model sees, and the run goes on", async () => {
    const exec = recorder();
    const h = harness({
      script: [call("c1", "calendar.create", { title: nest(15) }), say("after")],
    });
    refuseDeep(h);
    h.loop.registry.register({ spec: spec("calendar.create", "write"), execute: exec.execute });
    const events = await runTurn(h, "go");
    // The deep call never ran and no card was raised for it.
    expect(toolStatuses(events, "c1").at(-1)).toBe("failed");
    const result = resultsIn(h.provider.requests[1]).get("c1");
    expect(result?.isError).toBe(true);
    expect(result?.output).toMatchObject({ errorCode: "details_too_deep" });
    expect(JSON.stringify(result?.output)).toContain("flatter arguments");
    // The model was asked again with the error, and the run ended normally.
    expect(h.provider.requests).toHaveLength(2);
    expect(h.broker.issued).toHaveLength(0);
    expect(exec.seen).toHaveLength(0);
    expect(text(events)).toBe("after");
    expect(endOf(events).outcome).toBe("final");
  });

  it("any other refusal from the broker still fails the run", async () => {
    const h = harness({ script: [call("c1", "calendar.create", { title: "x" }), say("after")] });
    refuseDeep(h, new PsycheError("invalid_params", "something else"));
    h.loop.registry.register({
      spec: spec("calendar.create", "write"),
      execute: recorder().execute,
    });
    const events = await runTurn(h, "go");
    expect(endOf(events)).toMatchObject({ outcome: "failed" });
  });
});
