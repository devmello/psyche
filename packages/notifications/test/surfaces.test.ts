import type { ApprovalRequest, Notification } from "@psyche/protocol";
import { FakeChannelAdapter, SAMPLE_APPROVAL_REQUEST } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  channelText,
  createChannelSurface,
  createOsSurface,
  NOTIFY_SHOW_CAPABILITY,
} from "../src/index.ts";
import { helperNode, setup } from "./helpers.ts";

const base: Notification = {
  id: "ntf_1",
  kind: "task_done",
  title: "Subscription audit",
  body: "1 cancelled",
  taskId: "task_1",
  approvalId: null,
  route: "/tasks/task_1",
  actions: [{ id: "open", label: "Open" }],
  surfaces: ["desktop", "notification"],
  delivered: {},
  readAt: null,
  resolvedAt: null,
  createdAt: "2026-10-18T20:00:00.000Z",
};
const ctx = { surface: "notification", interruption: "active" as const, attempt: 1 };

describe("OS surface (mac helper notify.show)", () => {
  it("invokes notify.show with category, interruption level, thread and actions", async () => {
    const node = helperNode();
    const os = createOsSurface({ node: () => node });
    const approval: Notification = {
      ...base,
      kind: "approval",
      approvalId: "apr_1",
      actions: [
        { id: "approve", label: "Approve", authenticationRequired: true },
        { id: "deny", label: "Deny", destructive: true },
      ],
    };
    expect(await os.deliver(approval, { ...ctx, interruption: "timeSensitive" })).toEqual({
      status: "delivered",
    });
    expect(node.invocations[0]).toEqual({
      capability: NOTIFY_SHOW_CAPABILITY,
      params: {
        id: "ntf_1",
        category: "approval",
        title: "Subscription audit",
        body: "1 cancelled",
        interruptionLevel: "timeSensitive",
        threadId: "task_1",
        route: "/tasks/task_1",
        actions: [
          {
            id: "approve",
            label: "Approve",
            destructive: false,
            authenticationRequired: true,
            textInput: false,
          },
          {
            id: "deny",
            label: "Deny",
            destructive: true,
            authenticationRequired: false,
            textInput: false,
          },
        ],
      },
    });
  });

  it("offers a text reply for input_needed", async () => {
    const node = helperNode();
    await createOsSurface({ node: () => node }).deliver(
      { ...base, kind: "input_needed", actions: [{ id: "reply", label: "Answer" }] },
      ctx,
    );
    expect(
      (node.invocations[0]?.params as { actions?: { textInput: boolean }[] } | undefined)
        ?.actions?.[0]?.textInput,
    ).toBe(true);
  });

  it("falls back when no helper is connected, else fails retryably", async () => {
    const fallback = {
      name: "electron",
      handles: () => true,
      deliver: async () => ({ status: "delivered" as const }),
    };
    expect(await createOsSurface({ node: () => undefined, fallback }).deliver(base, ctx)).toEqual({
      status: "delivered",
    });
    expect(await createOsSurface({ node: () => undefined }).deliver(base, ctx)).toMatchObject({
      status: "failed",
      retryable: true,
    });
  });

  it("does not retry a helper without notify.show", async () => {
    const { FakeNodeClient } = await import("@psyche/testing");
    const res = await createOsSurface({ node: () => new FakeNodeClient() }).deliver(base, ctx);
    expect(res).toMatchObject({ status: "failed", retryable: false });
  });

  it("works end to end through the notifier", async () => {
    const node = helperNode();
    const { notifier } = setup({ adapters: [createOsSurface({ node: () => node })] });
    const n = await notifier.notify({ kind: "reminder", title: "Call mom", body: "at 6" });
    expect(n.delivered.notification).toBeTypeOf("string");
    expect(
      (node.invocations[0]?.params as { interruptionLevel?: string } | undefined)
        ?.interruptionLevel,
    ).toBe("passive");
  });
});

describe("channel surface", () => {
  async function running(caps: Partial<ReturnType<FakeChannelAdapter["capabilities"]>> = {}) {
    const adapter = new FakeChannelAdapter({ type: "telegram", capabilities: caps });
    await adapter.start();
    return adapter;
  }

  it("sends title, body and deep link to the peer", async () => {
    const tg = await running();
    const surface = createChannelSurface({ adapter: (c) => (c === "telegram" ? tg : undefined) });
    expect(await surface.deliver(base, { ...ctx, surface: "telegram:42" })).toEqual({
      status: "delivered",
    });
    expect(tg.sent).toMatchObject([
      {
        kind: "message",
        chatId: "42",
        text: "Subscription audit\n\n1 cancelled\n\nOpen in Psyche: /tasks/task_1",
      },
    ]);
  });

  it("truncates to the channel limit", () => {
    expect(channelText({ ...base, body: "x".repeat(100), route: null }, 20)).toHaveLength(20);
    expect(channelText({ ...base, body: "x".repeat(100), route: null }, 20).endsWith("…")).toBe(
      true,
    );
  });

  it("sends approval buttons only for approvals that may reach chat", async () => {
    const tg = await running();
    const approvals: Record<string, ApprovalRequest> = {
      apr_ok: { ...SAMPLE_APPROVAL_REQUEST, id: "apr_ok", deviceOnly: false },
      apr_device: { ...SAMPLE_APPROVAL_REQUEST, id: "apr_device", deviceOnly: true },
    };
    const surface = createChannelSurface({
      adapter: () => tg,
      approval: async (id) => {
        const approval = approvals[id];
        return approval === undefined ? undefined : { approval, answerToken: `tok_${id}` };
      },
    });
    const n = (approvalId: string): Notification => ({ ...base, kind: "approval", approvalId });
    const c = { ...ctx, surface: "telegram:42" };
    expect(await surface.deliver(n("apr_ok"), c)).toEqual({ status: "delivered" });
    expect(await surface.deliver(n("apr_device"), c)).toEqual({
      status: "suppressed",
      reason: "deviceOnly approval",
    });
    expect(await surface.deliver(n("apr_unknown"), c)).toMatchObject({ status: "suppressed" });
    expect(tg.sent).toEqual([
      expect.objectContaining({
        kind: "approval_buttons",
        approvalId: "apr_ok",
        answerToken: "tok_apr_ok",
      }),
    ]);
  });

  it("never sends approvals to a channel without buttons or without a resolver", async () => {
    const plain = await running({ buttons: false });
    const approval = async () => ({
      approval: { ...SAMPLE_APPROVAL_REQUEST, deviceOnly: false },
      answerToken: "t",
    });
    const n: Notification = { ...base, kind: "approval", approvalId: "apr_1" };
    const c = { ...ctx, surface: "telegram:42" };
    expect(
      await createChannelSurface({ adapter: () => plain, approval }).deliver(n, c),
    ).toMatchObject({
      status: "suppressed",
    });
    expect(await createChannelSurface({ adapter: () => plain }).deliver(n, c)).toMatchObject({
      status: "suppressed",
    });
    expect(plain.sent).toEqual([]);
  });

  it("fails retryably while the channel is down", async () => {
    const stopped = new FakeChannelAdapter({ type: "telegram" });
    const surface = createChannelSurface({
      adapter: (c) => (c === "telegram" ? stopped : undefined),
    });
    expect(await surface.deliver(base, { ...ctx, surface: "telegram:42" })).toMatchObject({
      status: "failed",
      retryable: true,
    });
    expect(await surface.deliver(base, { ...ctx, surface: "signal:7" })).toMatchObject({
      status: "failed",
      error: "channel signal not running",
    });
  });
});
