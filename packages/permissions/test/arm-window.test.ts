import { APPROVAL_ARM_DELAY_MS, PsycheError } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { createPermissionHandlers } from "../src/handlers.ts";
import { approvers, CTX, call, makeBroker, memoryDb, sqliteBroker } from "./helpers.ts";

/**
 * Item 5 of the approval QA: the 400 ms arming window never surfaces as an error. The card says
 * when it arms (`armedAt`), and a tap that lands inside the window waits and goes through.
 */
const WRITE = () =>
  call("calendar.create", "write", { kind: "origin", value: "https://cal.example" });
const CALLER = {
  deviceId: "dev_mac",
  scopes: ["operator.read", "operator.approvals"] as never,
  surface: "desktop" as const,
};

async function raise(
  broker: ReturnType<typeof makeBroker>["broker"],
  surfaces: ("desktop" | "web")[] = ["desktop"],
) {
  const c = WRITE();
  const d = await broker.decide(c, CTX);
  if (d.approvalKind === undefined || d.bindingHash === undefined || d.grantKey === undefined)
    throw new Error("expected ask");
  return broker.requestApproval({
    kind: d.approvalKind,
    summary: "test",
    details: {},
    bindingHash: d.bindingHash,
    grantKey: d.grantKey,
    requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
    sideEffect: c.sideEffect,
    ...(c.target === undefined ? {} : { target: c.target }),
    surfaces,
    taint: false,
  });
}

describe("the arming window", () => {
  it("the card carries armedAt = requestedAt + the arming delay", async () => {
    const h = makeBroker();
    const { approval } = await raise(h.broker);
    expect(Date.parse(approval.armedAt ?? "") - Date.parse(approval.requestedAt)).toBe(
      APPROVAL_ARM_DELAY_MS,
    );
  });

  it("armedAt survives a reload from SQLite", async () => {
    const broker = sqliteBroker(memoryDb(), new FakeClock());
    const issued = await raise(broker);
    const again = await broker.get(issued.approval.id);
    expect(again?.armedAt).toBe(issued.approval.armedAt);
  });

  it("the broker still refuses an answer before armedAt (the check stays)", async () => {
    const h = makeBroker();
    const issued = await raise(h.broker);
    await expect(
      h.broker.answer({
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop ?? "",
        decision: "approve",
        scope: "once",
        decidedBy: { deviceId: "dev_mac" },
      }),
    ).rejects.toMatchObject({ code: "approval_not_armed" });
  });

  it("a fast tap through approvals.answer waits out the window and is approved, not refused", async () => {
    const h = makeBroker();
    const slept: number[] = [];
    const handlers = createPermissionHandlers(h.broker, undefined, {
      sleep: async (ms) => {
        slept.push(ms);
        h.clock.advance(ms);
      },
    });
    const issued = await raise(h.broker);
    h.clock.advance(100); // an event-driven client answers 100 ms after approval.created
    const out = await handlers["approvals.answer"](
      {
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop,
        decision: "approve",
        scope: "once",
      },
      CALLER,
    );
    expect(out.approval.status).toBe("approved");
    // It waited only the rest of the existing window, never more.
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeLessThanOrEqual(APPROVAL_ARM_DELAY_MS);
  });

  it("an answer after the window does not wait at all (positive control)", async () => {
    const h = makeBroker();
    const handlers = createPermissionHandlers(h.broker, undefined, {
      sleep: async () => {
        throw new Error("must not sleep");
      },
    });
    const issued = await raise(h.broker);
    h.clock.advance(APPROVAL_ARM_DELAY_MS + 10);
    const out = await handlers["approvals.answer"](
      {
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop,
        decision: "deny",
      },
      CALLER,
    );
    expect(out.approval.status).toBe("denied");
  });

  it("other refusals are not retried (a wrong token still fails once)", async () => {
    const h = makeBroker();
    let slept = 0;
    const handlers = createPermissionHandlers(h.broker, undefined, {
      sleep: async () => {
        slept += 1;
      },
    });
    const issued = await raise(h.broker);
    h.clock.advance(APPROVAL_ARM_DELAY_MS + 10);
    await expect(
      handlers["approvals.answer"](
        {
          approvalId: issued.approval.id,
          answerToken: "at_wrong",
          decision: "approve",
          scope: "once",
        },
        CALLER,
      ),
    ).rejects.toBeInstanceOf(PsycheError);
    expect(slept).toBe(0);
  });
});

describe("state changes while a fast tap waits", () => {
  const answerInput = (issued: Awaited<ReturnType<typeof raise>>) => ({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop,
    decision: "approve",
    scope: "once",
  });

  it("a card denied on another surface meanwhile fails with answer_late", async () => {
    const h = makeBroker();
    const issued = await raise(h.broker, ["desktop", "web"]);
    const handlers = createPermissionHandlers(h.broker, undefined, {
      sleep: async (ms) => {
        h.clock.advance(ms);
        await h.broker.answer({
          approvalId: issued.approval.id,
          answerToken: issued.answerTokens.web ?? "",
          decision: "deny",
          decidedBy: { deviceId: "dev_web", surface: "web" },
        });
      },
    });
    h.clock.advance(100);
    await expect(handlers["approvals.answer"](answerInput(issued), CALLER)).rejects.toMatchObject({
      code: "answer_late",
    });
  });

  it("a device revoked meanwhile fails with forbidden", async () => {
    const devices = {
      dev_mac: { scopes: ["operator.read", "operator.approvals"] as never, revoked: false },
    };
    const h = makeBroker({ approvers: approvers(devices) });
    const issued = await raise(h.broker);
    const handlers = createPermissionHandlers(h.broker, undefined, {
      sleep: async (ms) => {
        h.clock.advance(ms);
        devices.dev_mac.revoked = true;
      },
    });
    h.clock.advance(100);
    await expect(handlers["approvals.answer"](answerInput(issued), CALLER)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("a card invalidated meanwhile fails with approval_invalidated", async () => {
    const h = makeBroker();
    const issued = await raise(h.broker);
    const handlers = createPermissionHandlers(h.broker, undefined, {
      sleep: async (ms) => {
        h.clock.advance(ms);
        await h.broker.reissue();
      },
    });
    h.clock.advance(100);
    await expect(handlers["approvals.answer"](answerInput(issued), CALLER)).rejects.toMatchObject({
      code: "approval_invalidated",
    });
  });

  it("a broker delay longer than the window still ends in approval_not_armed after exactly one sleep", async () => {
    const h = makeBroker({ armDelayMs: 5_000 });
    const issued = await raise(h.broker);
    let sleeps = 0;
    const handlers = createPermissionHandlers(h.broker, undefined, {
      sleep: async (ms) => {
        sleeps += 1;
        h.clock.advance(ms);
      },
    });
    await expect(handlers["approvals.answer"](answerInput(issued), CALLER)).rejects.toMatchObject({
      code: "approval_not_armed",
    });
    expect(sleeps).toBe(1);
  });
});
