import { describe, expect, it } from "vitest";
import { approve, CTX, call, makeBroker, origin } from "./helpers.ts";

/**
 * Taint vs standing grants for reads (INT-3 live V7, s1-research assertion 5): a tainted turn
 * navigating to an origin the owner already approved with a live standing grant is not a "new
 * origin" (security §3.2: balanced reads honor standing grants; §3.6: taint overrides
 * site / session / always grants only for write and above).
 */
describe("tainted reads and standing site grants", () => {
  const site = "https://energy-agency.example";
  // As the loop sends it: the target is the canonical origin, the path is in the params.
  const nav = (path = "/guides/cold-climate-heat-pumps") =>
    call("browser.navigate", "read", origin(site), {
      kind: "new_origin",
      params: { url: `${site}${path}` },
    });
  const tainted = {
    ...CTX,
    taint: true,
    taintSources: [{ sourceKind: "browser", origin: "https://other.example" }],
  };

  it("a live site grant is honored in a tainted turn: allow via the grant, no card", async () => {
    const h = makeBroker();
    // An earlier, untainted read approved for the site (a different Task).
    await approve(h, nav("/"), { ...CTX, taskId: "task_earlier" }, "site");
    const d = await h.broker.decide(nav(), tainted);
    expect(d.decision).toBe("allow");
    expect(d.rule).toMatch(/^grant:/);
    expect(d.trace).not.toContain("taint:new_origin");
    expect((await h.broker.list({ status: "pending" })).length).toBe(0);
  });

  it("without the grant the same tainted navigation asks", async () => {
    const h = makeBroker();
    const d = await h.broker.decide(nav(), tainted);
    expect(d).toMatchObject({ decision: "ask", rule: "taint:new_origin" });
  });

  it("an expired or revoked grant no longer counts", async () => {
    const h = makeBroker();
    const { approval } = await approve(h, nav("/"), { ...CTX, taskId: "task_earlier" }, "site");
    await h.broker.revokeGrant(approval.grantId ?? "");
    expect((await h.broker.decide(nav(), tainted)).rule).toBe("taint:new_origin");
  });

  it("a grant for another origin does not cover this one", async () => {
    const h = makeBroker();
    await approve(
      h,
      call("browser.navigate", "read", origin("https://other-agency.example/"), {
        kind: "new_origin",
      }),
      { ...CTX, taskId: "task_earlier" },
      "site",
    );
    expect((await h.broker.decide(nav(), tainted)).rule).toBe("taint:new_origin");
  });

  it("writes still escalate in a tainted turn despite a site grant", async () => {
    const h = makeBroker();
    const click = call("browser.click", "write", origin(`${site}/form`));
    await approve(h, click, { ...CTX, taskId: "task_earlier" }, "site");
    expect((await h.broker.decide(click, { ...CTX, taskId: "task_earlier" })).decision).toBe(
      "allow",
    );
    const d = await h.broker.decide(click, { ...tainted, newTarget: true });
    expect(d).toMatchObject({ decision: "ask", rule: "taint:new_target" });
  });
});
