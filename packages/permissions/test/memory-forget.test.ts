import { namespacedGrantKey } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { bindingHash } from "../src/index.ts";
import { approve, CTX, call, makeBroker } from "./helpers.ts";

/** `memory_forget` (QA 4, review r1): a "Forget everywhere" card, once only, per subject. */

/** The call as the agent loop sends it: binding hash and grant key precomputed from describeCall. */
const forget = (subject: string, over: { dry?: boolean } = {}) => {
  const params = { subject };
  return over.dry === true
    ? call("memory_forget", "none", undefined, { params })
    : call("memory_forget", "destructive", undefined, {
        kind: "memory_forget",
        params,
        bindingHash: bindingHash("memory_forget", {
          tool: "memory_forget",
          paramsHash: "h",
          fields: { subject },
        }),
        grantKey: namespacedGrantKey("memory_forget", `memory_forget|${subject}`),
      });
};

describe("memory_forget asks every time, once only", () => {
  it("raises a memory_forget card that offers `once` and nothing longer", async () => {
    const h = makeBroker();
    const d = await h.broker.decide(forget("sam"), CTX);
    expect(d).toMatchObject({
      decision: "ask",
      approvalKind: "memory_forget",
      rule: "memory:forget",
      scopesOffered: ["once"],
    });
  });

  it("refuses an Always or task answer, and an approval is not kept", async () => {
    const h = makeBroker();
    for (const scope of ["always", "task"] as const) {
      await expect(approve(h, forget("sam"), CTX, scope)).rejects.toMatchObject({
        code: "invalid_params",
      });
    }
    const { approval } = await approve(h, forget("sam"), CTX, "once");
    expect(approval.status).toBe("approved");
    expect(await h.broker.listGrants()).toEqual([]);
    expect((await h.broker.decide(forget("sam"), CTX)).decision).toBe("ask");
  });

  it("an approval for subject A never covers subject B", async () => {
    const h = makeBroker();
    const { d: a } = await approve(h, forget("sam"), CTX, "once");
    const b = await h.broker.decide(forget("alex"), CTX);
    expect(b).toMatchObject({ decision: "ask", rule: "memory:forget" });
    expect(b.grantKey).not.toBe(a.grantKey);
    expect(b.bindingHash).not.toBe(a.bindingHash);
  });

  it("control: a dry run needs no card", async () => {
    const h = makeBroker();
    const d = await h.broker.decide(forget("sam", { dry: true }), CTX);
    expect(d.decision).toBe("allow");
  });

  it("control: Full access still runs it without a card", async () => {
    const h = makeBroker();
    const d = await h.broker.decide(forget("sam"), { ...CTX, permissionMode: "full" });
    expect(d.decision).toBe("allow");
  });
});
