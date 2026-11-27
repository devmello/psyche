import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { ApprovalAnswer } from "../src/index.ts";

/**
 * "Run once without the sandbox" is a plain button on the card (S10), but the Gateway still takes
 * exactly the confirmation the typed word produced: the literal `UNSANDBOXED` field. Anything else
 * is refused at the schema, before the broker's own once-only, exec_host-only check.
 */
describe("the unsandboxed confirmation in an approval answer", () => {
  const base = { approvalId: "apr_1", answerToken: "tok", decision: "approve", scope: "once" };

  it("accepts the exact confirmation (positive control)", () => {
    expect(Value.Check(ApprovalAnswer, { ...base, unsandboxed: "UNSANDBOXED" })).toBe(true);
    expect(Value.Check(ApprovalAnswer, base)).toBe(true);
  });

  it.each([
    ["lower case", "unsandboxed"],
    ["a boolean", true],
    ["an empty string", ""],
    ["a near miss", "UNSANDBOXED "],
    ["another word", "yes"],
  ])("refuses %s", (_name, value) => {
    expect(Value.Check(ApprovalAnswer, { ...base, unsandboxed: value })).toBe(false);
  });
});
