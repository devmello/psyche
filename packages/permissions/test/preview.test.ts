import type { PermissionMode, PreviewResult, SideEffect } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import type { PolicyContext, PolicyDecision } from "../src/index.ts";
import { approve, CTX, call, type Harness, makeBroker, origin, recipient } from "./helpers.ts";

/**
 * `PermissionBroker.preview` (#686): a dry run of `decide`. It must give the decision `decide`
 * gives for the same intent in the same state (one evaluation, two callers), and it must leave the
 * broker exactly as it was. The expected asks come from docs/05 §3.2 (modes), §3.4 (scopes) and
 * §3.7 (device-only cards: destructive and financial asks are device-only).
 */

const TOOL = "conn.action";
const SHOP = "https://shop.example.com";
const MODES: PermissionMode[] = ["plan", "manual", "balanced", "auto"];
const CLASSES: SideEffect[] = ["none", "read", "write", "destructive", "financial"];

/** What the Task has done with the call before the dry run: nothing, one `once` read, or a standing grant. */
type Prior = "none" | "touched" | "grant";

/** The strongest scope the class allows (§3.4); financial never has a standing grant. */
const GRANT_SCOPE: Record<SideEffect, "once" | "task" | "always"> = {
  none: "once",
  read: "always",
  write: "always",
  destructive: "task",
  financial: "once",
};

const SETUP: PolicyContext = { ...CTX, permissionMode: "balanced", taint: false };

function ctxFor(mode: PermissionMode, taint: boolean): PolicyContext {
  return {
    ...CTX,
    permissionMode: mode,
    taint,
    ...(taint
      ? {
          newTarget: true,
          taintSources: [{ sourceKind: "browser_snapshot", origin: "https://evil.example.net" }],
        }
      : {}),
  };
}

/** Asserts a preview is the decision `decide` gave (or, for a residual auto write, that it asks). */
function expectPreviewMatches(p: PreviewResult, d: PolicyDecision, se: SideEffect): void {
  if (d.trace.includes("step7:classifier")) {
    // The classifier is a model call with audit and breaker effects, so a dry run cannot run it:
    // the residual auto-mode write previews as an ask, and the label decides when the call runs.
    expect(p).toMatchObject({ decision: "ask", rule: "classifier:deferred" });
    return;
  }
  expect(p.rule).toBe(d.rule);
  const deviceOnly = d.decision === "ask" && (se === "destructive" || se === "financial");
  expect(p.decision).toBe(deviceOnly ? "device-only" : d.decision);
  if (d.decision === "ask") {
    expect(p.approvalKind).toBe(d.approvalKind);
    expect(p.scopesOffered).toEqual(d.scopesOffered);
  } else {
    expect(p.approvalKind).toBeUndefined();
  }
}

describe("preview matches decide (#686)", () => {
  for (const mode of MODES) {
    for (const se of CLASSES) {
      for (const taint of [false, true]) {
        const priors: Prior[] =
          se === "none"
            ? ["none"]
            : se === "read"
              ? ["none", "touched", "grant"]
              : ["none", "grant"];
        for (const prior of priors) {
          const name = `${mode} × ${se} × ${taint ? "tainted(newTarget)" : "untainted"} × prior:${prior}`;
          it(name, async () => {
            const h = makeBroker();
            const c = call(TOOL, se, origin(SHOP));
            if (prior === "touched") await approve(h, c, SETUP, "once");
            if (prior === "grant") await approve(h, c, SETUP, GRANT_SCOPE[se]);

            const ctx = ctxFor(mode, taint);
            const [p] = await h.broker.preview([c], ctx);
            const d = await h.broker.decide(c, ctx);

            expect(p).toBeDefined();
            expectPreviewMatches(p as PreviewResult, d, se);
          });
        }
      }
    }
  }
});

describe("sends, destructive, financial and device-only actions (docs/05 §3.2, §3.7)", () => {
  const sensitive = [
    call("email.send", "destructive", recipient("pat@example.com")),
    call(TOOL, "destructive", origin(SHOP)),
    call(TOOL, "financial", origin(SHOP)),
    call("conn.pair", "write", undefined, { kind: "pairing" }),
  ];

  for (const mode of ["manual", "balanced", "auto"] as const) {
    it(`previews every one as device-only in ${mode} mode`, async () => {
      const h = makeBroker();
      const previews = await h.broker.preview(sensitive, ctxFor(mode, false));
      expect(previews.map((p) => p.decision)).toEqual([
        "device-only",
        "device-only",
        "device-only",
        "device-only",
      ]);
      expect(previews.map((p) => p.approvalKind)).toEqual([
        "send_email",
        "connector_action",
        "connector_action",
        "pairing",
      ]);
    });
  }

  it("previews plan mode as deny, per docs/05 §3.2", async () => {
    const h = makeBroker();
    const previews = await h.broker.preview(sensitive, ctxFor("plan", false));
    expect(previews.map((p) => [p.decision, p.rule])).toEqual(
      sensitive.map(() => ["deny", "mode:plan"]),
    );
  });

  it("makes an owner's extra deviceOnly kind device-only", async () => {
    const h = makeBroker({ policy: { approvals: { deviceOnly: ["calendar_write"] } } });
    const [p] = await h.broker.preview([call("calendar.add", "write")], ctxFor("balanced", false));
    expect(p).toMatchObject({ decision: "device-only", approvalKind: "calendar_write" });
  });
});

describe("preview is side-effect free (#686)", () => {
  /** Everything the broker keeps that a caller can read back, serialized. */
  async function snapshot(h: Harness): Promise<string> {
    return JSON.stringify({
      grants: await h.broker.listGrants({ includeRevoked: true }),
      approvals: await h.broker.list(),
      receipts: await h.broker.listReceipts(),
      notifications: await h.notifier.list(),
      audit: [...h.audit.store.entries()],
    });
  }

  /** A pending, unanswered card, as `decide` followed by `requestApproval` leaves it. */
  async function pending(h: Harness, c: ReturnType<typeof call>, ctx: PolicyContext) {
    const d = await h.broker.decide(c, ctx);
    if (d.approvalKind === undefined || d.bindingHash === undefined || d.grantKey === undefined) {
      throw new Error(`expected ask, got ${d.decision} (${d.rule})`);
    }
    await h.broker.requestApproval({
      kind: d.approvalKind,
      summary: `test ${c.tool}`,
      details: {},
      bindingHash: d.bindingHash,
      grantKey: d.grantKey,
      requestedBy: { runId: ctx.runId, taskId: ctx.taskId ?? null, threadId: ctx.threadId },
      sideEffect: c.sideEffect,
      surfaces: ["desktop"],
      taint: ctx.taint,
    });
  }

  it("changes no grant, approval, receipt, notification or audit entry", async () => {
    const h = makeBroker();
    const standing = call(TOOL, "read", origin(SHOP));
    await approve(h, standing, SETUP, "always");
    await pending(h, call(TOOL, "write", origin(SHOP)), SETUP);
    await h.broker.recordReceipt({ kind: "conn.action", outcome: "ok", summary: "earlier" });
    const newRead = call(TOOL, "read", origin("https://new.example.org"));

    const before = await snapshot(h);
    const previews = await h.broker.preview(
      [
        standing,
        newRead,
        call(TOOL, "write", origin(SHOP)),
        call("email.send", "destructive", recipient("pat@example.com")),
        call(TOOL, "financial", origin(SHOP)),
      ],
      ctxFor("balanced", false),
    );

    expect(previews[0]?.rule).toMatch(/^grant:/);
    expect(await snapshot(h)).toBe(before);
  });

  it("does not mark a read's source touched, so a later decide still asks", async () => {
    const h = makeBroker();
    const newRead = call(TOOL, "read", origin("https://new.example.org"));
    const ctx = ctxFor("balanced", false);

    const [first] = await h.broker.preview([newRead], ctx);
    const [again] = await h.broker.preview([newRead], ctx);
    const decided = await h.broker.decide(newRead, ctx);

    expect(first).toMatchObject({ decision: "ask", rule: "mode:balanced/read:new_source" });
    expect(again).toEqual(first);
    expect(decided).toMatchObject({ decision: "ask", rule: "mode:balanced/read:new_source" });
  });

  it("does not count a use of a standing grant", async () => {
    const h = makeBroker();
    const standing = call(TOOL, "read", origin(SHOP));
    await approve(h, standing, SETUP, "always");
    const [grant] = await h.broker.listGrants();
    expect(grant?.useCount).toBe(0);

    const [p] = await h.broker.preview([standing], ctxFor("balanced", false));
    expect(p).toMatchObject({ decision: "allow", rule: `grant:${grant?.id}` });
    expect((await h.broker.listGrants())[0]?.useCount).toBe(0);
  });
});
