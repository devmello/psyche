import { describe, expect, it } from "vitest";
import {
  isSeparateDesktopCredentialKey,
  type PolicyContext,
  separateDesktopCredentialGrantKey,
} from "../src/index.ts";
import { DEVICE, makeBroker } from "./helpers.ts";

/**
 * A saved login typed into the Linux separate desktop has its own grant key and is `once` only: a
 * standing "site" grant the owner gave the Host's agent browser for the same origin never
 * approves it, and answering one can never create a grant that would.
 */

const ORIGIN = "https://bank.example";
const ctx: PolicyContext = {
  threadId: "thr_a",
  runId: "run_1",
  taskId: "task_1",
  permissionMode: "balanced",
  taint: false,
};

const ask = async (
  h: ReturnType<typeof makeBroker>,
  grantKey: string,
  offered: ("once" | "site")[],
) => {
  const issued = await h.broker.requestApproval({
    kind: "credential_fill",
    summary: `Fill the login for ${ORIGIN}`,
    details: { origin: ORIGIN, item: "Bank", separateDesktop: true },
    bindingHash: `c${Math.random()}`.replace(".", "") as never,
    grantKey,
    requestedBy: { runId: ctx.runId, taskId: ctx.taskId ?? null, threadId: ctx.threadId },
    sideEffect: "write",
    surfaces: ["desktop"],
    scopesOffered: offered,
    taint: false,
  });
  h.clock.advance(500);
  return issued;
};

const answer = (
  h: ReturnType<typeof makeBroker>,
  issued: Awaited<ReturnType<typeof ask>>,
  scope: "once" | "site",
) =>
  h.broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop ?? "",
    decision: "approve",
    scope,
    decidedBy: DEVICE,
  });

describe("credential fills in the separate desktop", () => {
  it("their grant key is its own namespace", () => {
    const key = separateDesktopCredentialGrantKey(ORIGIN);
    expect(key).toBe("credential_fill|separate_desktop|https://bank.example");
    expect(isSeparateDesktopCredentialKey(key)).toBe(true);
    expect(isSeparateDesktopCredentialKey(`credential_fill|${ORIGIN}`)).toBe(false);
  });

  it("the broker offers once only, even if the caller offered site", async () => {
    const h = makeBroker();
    const issued = await ask(h, separateDesktopCredentialGrantKey(ORIGIN), ["once", "site"]);
    expect(issued.approval.scopesOffered).toEqual(["once"]);
  });

  it("a host site grant for the same origin does not make the separate-desktop card go away, and answering never makes a grant", async () => {
    const h = makeBroker();
    // The owner gave the Host's agent browser a standing grant for this origin.
    const hostKey = `credential_fill|${ORIGIN}`;
    const host = await ask(h, hostKey, ["once", "site"]);
    await answer(h, host, "site");
    const before = await h.broker.listGrants();
    expect(before.some((g) => g.grantKey === hostKey && g.scope === "site")).toBe(true);
    // A separate-desktop fill for the same origin is a fresh, pending, once-only card.
    const sdKey = separateDesktopCredentialGrantKey(ORIGIN);
    const first = await ask(h, sdKey, ["once"]);
    expect(first.approval.status).toBe("pending");
    expect(first.approval.scopesOffered).toEqual(["once"]);
    await expect(answer(h, first, "site")).rejects.toBeDefined();
    const done = await answer(h, await ask(h, sdKey, ["once"]), "once");
    expect(done.status).toBe("approved");
    // Nothing was added to the ledger, so the next fill is a fresh card again.
    const after = await h.broker.listGrants();
    expect(after.length).toBe(before.length);
    expect(after.some((g) => g.grantKey === sdKey)).toBe(false);
    const next = await ask(h, sdKey, ["once"]);
    expect(next.approval.status).toBe("pending");
  });
});
