import type { Notification } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { createOsSurface, NOTIFY_SHOW_CAPABILITY } from "../src/index.ts";
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
