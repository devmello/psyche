import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CTX, call, makeBroker, origin } from "../helpers.ts";
import { FUZZ } from "./config.ts";

/**
 * The approval lifecycle under random operation sequences (security §3.7): at most one answer is
 * ever accepted, nothing is accepted before arming, after expiry, after a restart or after the run
 * was cancelled, and a `once` approval verifies at most once and only for its own binding.
 */

type Op =
  | {
      op: "answer";
      surface: "desktop" | "web" | "telegram:1";
      who: "mac" | "reader" | "node" | "owner_chat" | "friend_chat";
      decision: "approve" | "deny";
      scope: "once" | "always";
    }
  | { op: "forge" }
  | { op: "advance"; ms: number }
  | { op: "verify"; same: boolean }
  | { op: "reissue" }
  | { op: "cancel" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    op: fc.constant("answer" as const),
    surface: fc.constantFrom("desktop" as const, "web" as const, "telegram:1" as const),
    who: fc.constantFrom(
      "mac" as const,
      "reader" as const,
      "node" as const,
      "owner_chat" as const,
      "friend_chat" as const,
    ),
    decision: fc.constantFrom("approve" as const, "deny" as const),
    scope: fc.constantFrom("once" as const, "always" as const),
  }),
  fc.constant({ op: "forge" as const }),
  fc.record({
    op: fc.constant("advance" as const),
    ms: fc.constantFrom(100, 450, 60_000, 29 * 60_000, 31 * 60_000),
  }),
  fc.record({ op: fc.constant("verify" as const), same: fc.boolean() }),
  fc.constant({ op: "reissue" as const }),
  fc.constant({ op: "cancel" as const }),
);

const WHO = {
  mac: { deviceId: "dev_mac" },
  reader: { deviceId: "dev_reader" },
  node: { deviceId: "dev_node" },
  owner_chat: { channel: "telegram", senderId: "owner-1" },
  friend_chat: { channel: "telegram", senderId: "friend" },
} as const;

describe("fuzz: approval lifecycle", () => {
  it(
    "first authorized answer wins; nothing late, replayed, unarmed or cancelled counts",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.boolean(),
          fc.array(opArb, { minLength: 1, maxLength: 14 }),
          async (destructive, ops) => {
            const h = makeBroker();
            const c = destructive
              ? call("messages.send", "destructive", { kind: "recipient", value: "bob" })
              : call("calendar.create", "write", origin("https://cal.example.com"));
            const d = await h.broker.decide(c, CTX);
            const issued = await h.broker.requestApproval({
              kind: d.approvalKind ?? "connector_action",
              summary: "fuzz",
              details: {},
              bindingHash: d.bindingHash ?? "",
              grantKey: d.grantKey ?? "",
              requestedBy: { runId: CTX.runId, taskId: CTX.taskId ?? null, threadId: CTX.threadId },
              sideEffect: c.sideEffect,
              surfaces: ["desktop", "web", "telegram:1"],
              taint: false,
            });
            const id = issued.approval.id;
            const requestedAt = Date.parse(issued.approval.requestedAt);
            let accepted = 0;
            let verifiedOnce = 0;
            let invalidated = false;
            let cancelled = false;
            for (const o of ops) {
              const why = JSON.stringify({ destructive, ops, at: o });
              if (o.op === "advance") h.clock.advance(o.ms);
              else if (o.op === "reissue") {
                await h.broker.reissue();
                invalidated = true;
              } else if (o.op === "cancel") {
                await h.broker.revokeRunAuthority(CTX.runId);
                cancelled = true;
              } else if (o.op === "forge") {
                await expect(
                  h.broker.answer({
                    approvalId: id,
                    answerToken: "at_forged",
                    decision: "approve",
                    decidedBy: WHO.mac,
                  }),
                  why,
                ).rejects.toBeDefined();
              } else if (o.op === "verify") {
                const v = await h.broker.verifyBinding(
                  id,
                  o.same ? issued.approval.bindingHash : `sha256:${"0".repeat(64)}`,
                );
                if (v.ok) {
                  expect(o.same, why).toBe(true);
                  // A cancelled run verifies nothing; a restart ends unconsumed `once` approvals.
                  expect(cancelled, why).toBe(false);
                  const a = await h.broker.get(id);
                  if (a?.scopeGranted === "once") {
                    expect(invalidated, why).toBe(false);
                    verifiedOnce += 1;
                  }
                }
              } else {
                const token = issued.answerTokens[o.surface];
                const now = h.clock.now();
                const res = await h.broker
                  .answer({
                    approvalId: id,
                    answerToken: token ?? "missing",
                    decision: o.decision,
                    scope: o.scope,
                    decidedBy: WHO[o.who],
                  })
                  .then(
                    (a) => a,
                    () => undefined,
                  );
                if (res !== undefined) {
                  accepted += 1;
                  // Only an approver, on its own surface, armed, unexpired, not invalidated or cancelled.
                  expect(now - requestedAt, why).toBeGreaterThanOrEqual(400);
                  expect(now - requestedAt, why).toBeLessThan(30 * 60_000);
                  expect(invalidated || cancelled, why).toBe(false);
                  const chat = o.surface.includes(":");
                  expect(chat ? o.who === "owner_chat" : o.who === "mac", why).toBe(true);
                  if (chat) expect(destructive, why).toBe(false);
                  if (chat && o.decision === "approve") expect(o.scope, why).toBe("once");
                  if (destructive && o.decision === "approve") expect(o.scope, why).toBe("once");
                }
              }
              expect(accepted, why).toBeLessThanOrEqual(1);
              expect(verifiedOnce, why).toBeLessThanOrEqual(1);
            }
          },
        ),
        { seed: FUZZ.seed, numRuns: FUZZ.asyncRuns },
      );
    },
    FUZZ.timeoutMs,
  );
});
