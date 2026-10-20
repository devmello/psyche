import { describe, expect, it } from "vitest";
import { CTX, call, makeBroker } from "./helpers.ts";

/** The owner's own inbox is not an action the owner approves (#307, docs/02 §4.3, C8). */

describe("notify to the owner's own inbox (#307)", () => {
  const notify = (value = "owner") =>
    call("notify", "write", { kind: "recipient", value }, { params: { title: "Weekly review" } });

  it("needs no card in manual, balanced or auto, tainted or not, attended or unattended", async () => {
    const h = makeBroker();
    for (const permissionMode of ["manual", "balanced", "auto"] as const) {
      for (const taint of [false, true]) {
        for (const unattended of [false, true]) {
          const d = await h.broker.decide(notify(), {
            ...CTX,
            permissionMode,
            taint,
            ...(unattended ? { unattended } : {}),
          });
          expect(d, `${permissionMode} taint=${taint}`).toMatchObject({
            decision: "allow",
            rule: "owner_inbox",
          });
        }
      }
    }
  });

  it("plan mode, a deny rule, an ask rule and other recipients still apply", async () => {
    expect(
      (await makeBroker().broker.decide(notify(), { ...CTX, permissionMode: "plan" })).decision,
    ).toBe("deny");
    expect(
      (await makeBroker({ policy: { deny: ["notify"] } }).broker.decide(notify(), CTX)).decision,
    ).toBe("deny");
    expect(
      (await makeBroker({ policy: { ask: ["notify"] } }).broker.decide(notify(), CTX)).decision,
    ).toBe("ask");
    expect((await makeBroker().broker.decide(notify("sam@example.com"), CTX)).rule).not.toBe(
      "owner_inbox",
    );
  });
});
