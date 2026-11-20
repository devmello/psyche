import { describe, expect, it } from "vitest";
import { type Caller, createPermissionHandlers, type PolicyCall } from "../src/index.ts";
import { approvers, makeBroker as baseBroker, CTX, call, origin } from "./helpers.ts";

const scopes = {
  scopes: ["operator.read", "operator.approvals"] as ("operator.read" | "operator.approvals")[],
};
const devices = {
  dev_mac: scopes,
  dev_phone: scopes,
  dev_other: scopes,
  dev_shell: scopes,
};
const makeBroker = (o: Parameters<typeof baseBroker>[0] = {}) =>
  baseBroker({ approvers: approvers(devices), ...o });

/**
 * The lockout cap counts only rejections that look like guessing. A client that keeps answering a
 * card that already closed (a stale window, a retry loop) must not lock the owner out, and the
 * owner's own Host app is never locked out by its own bugs. A guesser still is.
 */

const write = () => call("calendar.create", "write", origin("https://calendar.example.com"));

async function request(h: ReturnType<typeof makeBroker>, c: PolicyCall) {
  const d = await h.broker.decide(c, CTX);
  return h.broker.requestApproval({
    kind: d.approvalKind ?? "connector_action",
    summary: `do ${c.tool}`,
    details: { tool: c.tool },
    bindingHash: d.bindingHash ?? "",
    grantKey: d.grantKey ?? "",
    requestedBy: { runId: CTX.runId, taskId: CTX.taskId ?? null, threadId: CTX.threadId },
    sideEffect: c.sideEffect,
    ...(c.target === undefined ? {} : { target: c.target }),
    surfaces: ["desktop", "web"],
    taint: false,
  });
}

const by = (deviceId: string) => ({ deviceId, surface: "desktop" as const });

describe("answer lockout counts guessing only", () => {
  it("benign refusals never lock a device out, however many arrive", async () => {
    const h = makeBroker();
    const issued = await request(h, write());
    h.clock.advance(500);
    const token = issued.answerTokens.desktop ?? "";
    await h.broker.answer({
      approvalId: issued.approval.id,
      answerToken: token,
      decision: "deny",
      decidedBy: by("dev_mac"),
    });
    // Re-submits of a closed card, unknown ids and cancelled sheets.
    for (let i = 0; i < 50; i += 1) {
      await expect(
        h.broker.answer({
          approvalId: issued.approval.id,
          answerToken: token,
          decision: "deny",
          decidedBy: by("dev_mac"),
        }),
      ).rejects.toMatchObject({ code: "answer_replayed" });
    }
    for (let i = 0; i < 50; i += 1) {
      await expect(
        h.broker.answer({
          approvalId: "apr_missing",
          answerToken: "at_x",
          decision: "deny",
          decidedBy: by("dev_mac"),
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        h.broker.precheckAnswer({
          approvalId: "apr_missing",
          answerToken: "at_x",
          decidedBy: by("dev_mac"),
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        h.broker.rejectPresence({
          approvalId: issued.approval.id,
          decidedBy: by("dev_mac"),
          reason: "presence_cancelled",
          code: "cancelled",
          message: "cancelled",
        }),
      ).rejects.toMatchObject({ code: "cancelled" });
    }
    // The 50 replays count (a reused token looks like guessing) but stay under the cap of 60; the 100 benign refusals do not count.
    const next = await request(h, write());
    h.clock.advance(500);
    const ok = await h.broker.answer({
      approvalId: next.approval.id,
      answerToken: next.answerTokens.desktop ?? "",
      decision: "deny",
      decidedBy: by("dev_mac"),
    });
    expect(ok.status).toBe("denied");
  });

  it("a late answer to an expired or closed card is audited and not counted", async () => {
    const h = makeBroker();
    const issued = await request(h, write());
    h.clock.advance(31 * 60_000);
    for (let i = 0; i < 100; i += 1) {
      await expect(
        h.broker.answer({
          approvalId: issued.approval.id,
          answerToken: issued.answerTokens.desktop ?? "",
          decision: "approve",
          decidedBy: by("dev_phone"),
        }),
      ).rejects.toMatchObject({ code: "approval_expired" });
    }
    const rejected = await h.audit.query({ kind: "approval.answer_rejected" });
    expect(rejected).toHaveLength(100);
    const next = await request(h, write());
    h.clock.advance(500);
    await expect(
      h.broker.answer({
        approvalId: next.approval.id,
        answerToken: next.answerTokens.desktop ?? "",
        decision: "deny",
        decidedBy: by("dev_phone"),
      }),
    ).resolves.toMatchObject({ status: "denied" });
  });

  it("guessing answer tokens still locks a remote device out, with a retry-after", async () => {
    const h = makeBroker();
    const issued = await request(h, write());
    h.clock.advance(500);
    for (let i = 0; i < 60; i += 1) {
      await expect(
        h.broker.answer({
          approvalId: issued.approval.id,
          answerToken: `at_guess_${i}`,
          decision: "approve",
          decidedBy: by("dev_phone"),
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    const locked = {
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens.desktop ?? "",
      decision: "deny" as const,
      decidedBy: by("dev_phone"),
    };
    await expect(h.broker.answer(locked)).rejects.toMatchObject({
      code: "rate_limited",
      details: { retryAfterSec: expect.any(Number) },
    });
    // The same lockout stops the precheck before any sheet is raised.
    await expect(
      h.broker.precheckAnswer({
        approvalId: issued.approval.id,
        answerToken: locked.answerToken,
        decidedBy: locked.decidedBy,
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    // Another device is unaffected, and the lockout ends with the window.
    await expect(
      h.broker.precheckAnswer({
        approvalId: issued.approval.id,
        answerToken: locked.answerToken,
        decidedBy: by("dev_other"),
      }),
    ).resolves.toBeDefined();
    h.clock.advance(61_000);
    await expect(h.broker.answer(locked)).resolves.toMatchObject({ status: "denied" });
  });

  it("failed presence counts like a bad assertion, a cancelled sheet does not", async () => {
    const h = makeBroker();
    const issued = await request(h, write());
    for (let i = 0; i < 60; i += 1) {
      await expect(
        h.broker.rejectPresence({
          approvalId: issued.approval.id,
          decidedBy: by("dev_phone"),
          reason: "presence_failed",
          code: "forbidden",
          message: "did not confirm",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(
      h.broker.precheckAnswer({
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop ?? "",
        decidedBy: by("dev_phone"),
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("the owner's own Host device is audited but never locked out", async () => {
    const h = makeBroker();
    const issued = await request(h, write());
    h.clock.advance(500);
    for (let i = 0; i < 200; i += 1) {
      await expect(
        h.broker.answer(
          {
            approvalId: issued.approval.id,
            answerToken: `at_stale_${i}`,
            decision: "approve",
            decidedBy: by("dev_shell"),
          },
          { local: true },
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect((await h.audit.query({ kind: "approval.answer_rejected" })).length).toBe(200);
    const ok = await h.broker.answer(
      {
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop ?? "",
        decision: "deny",
        decidedBy: by("dev_shell"),
      },
      { local: true },
    );
    expect(ok.status).toBe("denied");
    // A remote device making the same mistakes is still stopped.
    const next = await request(h, write());
    h.clock.advance(500);
    for (let i = 0; i < 60; i += 1) {
      await h.broker
        .answer({
          approvalId: next.approval.id,
          answerToken: `at_bad_${i}`,
          decision: "approve",
          decidedBy: by("dev_phone"),
        })
        .catch(() => undefined);
    }
    await expect(
      h.broker.answer({
        approvalId: next.approval.id,
        answerToken: next.answerTokens.desktop ?? "",
        decision: "deny",
        decidedBy: by("dev_phone"),
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("local is a property of the call, not of the device id", async () => {
    const h = makeBroker();
    const issued = await request(h, write());
    h.clock.advance(500);
    // The shell's device id, from a connection the Gateway did not vouch for (a reused key).
    for (let i = 0; i < 60; i += 1) {
      await h.broker
        .answer({
          approvalId: issued.approval.id,
          answerToken: `at_bad_${i}`,
          decision: "approve",
          decidedBy: by("dev_shell"),
        })
        .catch(() => undefined);
    }
    await expect(
      h.broker.answer({
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop ?? "",
        decision: "deny",
        decidedBy: by("dev_shell"),
      }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    // The vouched call from the same id is not held back by those guesses (it is only subject to
    // the answer budget), so the owner's own app is not locked out by someone else's mistakes.
    await expect(
      h.broker.precheckAnswer({
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop ?? "",
        decidedBy: by("dev_shell"),
        local: true,
      }),
    ).resolves.toBeDefined();
  });

  it("a client cannot claim to be local by sending the flag in its params", async () => {
    const h = makeBroker();
    const handlers = createPermissionHandlers(h.broker, h.audit);
    const phone: Caller = {
      deviceId: "dev_phone",
      scopes: ["operator.read", "operator.approvals"],
      surface: "desktop",
    };
    const issued = await request(h, write());
    h.clock.advance(500);
    // 200 guessed tokens, each claiming `local: true` (the schema lets extra keys through).
    const codes: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const res = await handlers["approvals.answer"](
        {
          approvalId: issued.approval.id,
          answerToken: `at_guess_${i}`,
          decision: "approve",
          local: true,
        },
        phone,
      ).catch((e: { code: string }) => e);
      codes.push((res as { code?: string }).code ?? "ok");
    }
    expect(codes).toContain("rate_limited");
    expect(codes.filter((c) => c === "forbidden").length).toBeLessThanOrEqual(60);
    // The same smuggled flag straight on the broker input (the chat path spreads its input too).
    await expect(
      h.broker.answer({
        approvalId: issued.approval.id,
        answerToken: "at_more",
        decision: "approve",
        decidedBy: by("dev_phone"),
        local: true,
      } as never),
    ).rejects.toMatchObject({ code: "rate_limited" });
    // A connection the Gateway vouched for is not limited by the same guesses.
    const shell: Caller = { ...phone, deviceId: "dev_shell", local: true };
    for (let i = 0; i < 100; i += 1) {
      await expect(
        handlers["approvals.answer"](
          { approvalId: issued.approval.id, answerToken: `at_g_${i}`, decision: "approve" },
          shell,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("a chat sender cannot claim to be local either", async () => {
    const h = makeBroker({ approvers: approvers({ ...devices }, ["telegram:owner-1"]) });
    const issued = await request(h, write());
    h.clock.advance(500);
    const chat = { channel: "telegram", senderId: "owner-1" } as never;
    const codes: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const res = await h.broker
        .answer({
          approvalId: issued.approval.id,
          answerToken: `at_guess_${i}`,
          decision: "approve",
          scope: "once",
          decidedBy: chat,
          local: true,
        } as never)
        .catch((e: { code: string }) => e);
      codes.push((res as { code?: string }).code ?? "ok");
    }
    expect(codes).toContain("rate_limited");
  });
});
