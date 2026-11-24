import type { ApprovalRequest, Notification } from "@psyche/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  GatewayProvider,
  GatewayStore,
  useApprovals,
  useNotifications,
} from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";

const NOW = "2026-10-18T10:12:00Z";
const HASH = `sha256:${"9f".repeat(32)}`;

/** `n` minutes before NOW, so a larger `n` is older. */
const ago = (n: number) => new Date(Date.parse(NOW) - n * 60_000).toISOString();

function approval(id: string, n: number, status: ApprovalRequest["status"]): ApprovalRequest {
  return {
    id,
    kind: "send_email",
    summary: "Send an email",
    details: { tool: "email.send", params: {}, target: "jane@example.com" },
    bindingHash: HASH,
    grantKey: "email.send|example.com",
    requestedBy: { runId: null, taskId: null, threadId: null },
    surfaces: ["desktop"],
    scopesOffered: ["once"],
    deviceOnly: false,
    requiresAuthentication: false,
    taint: false,
    status,
    scopeGranted: null,
    decidedBy: null,
    requestedAt: ago(n),
    expiresAt: "2099-01-01T00:00:00Z",
    decidedAt: status === "pending" ? null : ago(n),
    grantId: null,
  };
}

function notification(id: string, n: number, extra: Partial<Notification> = {}): Notification {
  return {
    id,
    kind: "task_done",
    title: id,
    body: "",
    taskId: null,
    approvalId: null,
    route: "/",
    actions: [],
    surfaces: ["desktop"],
    delivered: {},
    readAt: null,
    resolvedAt: null,
    createdAt: ago(n),
    ...extra,
  } as Notification;
}

function setup(world: ConstructorParameters<typeof MockGateway>[0]) {
  const gateway = new MockGateway(world, { now: () => NOW });
  const store = new GatewayStore(gateway, { now: () => NOW });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <GatewayProvider client={gateway} store={store}>
      {children}
    </GatewayProvider>
  );
  return { gateway, store, wrapper };
}

describe("useApprovals beyond the first page", () => {
  // 60 decided approvals, all newer than one pending approval: the pending one is 61st of any
  // status, so a single default-limit page never reaches it.
  const decided = Array.from({ length: 60 }, (_, i) => approval(`done_${i}`, i + 1, "approved"));
  const old = approval("ap_old", 500, "pending");

  it("gives an old pending approval a card and an answer token", async () => {
    const { gateway, wrapper } = setup({
      approvals: [...decided, old],
      answerTokens: { ap_old: "at_old" },
    });
    const { result } = renderHook(() => useApprovals(), { wrapper });
    await waitFor(() =>
      expect(result.current.pending.map((v) => v.approval.id)).toEqual(["ap_old"]),
    );
    expect(result.current.pending[0]?.canAnswer).toBe(true);

    await act(() => result.current.answer("ap_old", "approve", "once"));
    expect(gateway.calls.find((c) => c.method === "approvals.answer")?.params).toMatchObject({
      approvalId: "ap_old",
      answerToken: "at_old",
    });
  });

  it("follows the cursor through more pending approvals than one page holds", async () => {
    const many = Array.from({ length: 620 }, (_, i) => approval(`p_${i}`, i + 1, "pending"));
    const tokens = Object.fromEntries(many.map((a) => [a.id, `at_${a.id}`]));
    const { wrapper } = setup({ approvals: many, answerTokens: tokens });
    const { result } = renderHook(() => useApprovals(), { wrapper });
    await waitFor(() => expect(result.current.pending).toHaveLength(620));
    expect(result.current.pending.every((v) => v.canAnswer)).toBe(true);
  });

  it("loads the decided history paged, and a live event still updates both sets", async () => {
    const history = Array.from({ length: 130 }, (_, i) => approval(`h_${i}`, i + 1, "denied"));
    const { gateway, wrapper } = setup({
      approvals: [...history, old],
      answerTokens: { ap_old: "at_old" },
    });
    const { result } = renderHook(() => useApprovals(), { wrapper });
    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    expect(result.current.recent).toHaveLength(100);
    expect(result.current.hasMoreRecent).toBe(true);

    await act(() => result.current.loadMoreRecent());
    expect(result.current.recent).toHaveLength(130);
    expect(result.current.hasMoreRecent).toBe(false);

    // The old approval is decided elsewhere: it leaves pending and joins the history.
    act(() => {
      gateway.emit("approval.updated", { approval: { ...old, status: "approved" } });
    });
    await waitFor(() => expect(result.current.pending).toHaveLength(0));
    expect(result.current.recent).toHaveLength(131);

    // A new approval arrives live.
    act(() => {
      gateway.emit("approval.created", {
        approval: approval("ap_new", 0, "pending"),
        answerToken: "at_new",
      });
    });
    await waitFor(() =>
      expect(result.current.pending.map((v) => v.approval.id)).toEqual(["ap_new"]),
    );
  });
});

describe("useNotifications beyond the first page", () => {
  it("pages the inbox list and counts old unread and unresolved ones", async () => {
    // 70 read, resolved notifications, and one old notification that is unread and unresolved.
    const readDone = Array.from({ length: 70 }, (_, i) =>
      notification(`n_${i}`, i + 1, { readAt: NOW, resolvedAt: NOW }),
    );
    const oldOne = notification("n_old", 900, { kind: "approval", approvalId: "ap_old" });
    const { wrapper } = setup({ notifications: [...readDone, oldOne] });
    const { result } = renderHook(() => useNotifications(), { wrapper });

    // Counts include the old one although it is outside the first page of 50.
    await waitFor(() => expect(result.current.unread.map((n) => n.id)).toEqual(["n_old"]));
    expect(result.current.unresolved.map((n) => n.id)).toEqual(["n_old"]);

    // The list head is 50 rows plus the old one the counts needed.
    expect(result.current.all).toHaveLength(51);
    expect(result.current.hasMore).toBe(true);
    await act(() => result.current.loadMore());
    expect(result.current.all).toHaveLength(71);
    expect(result.current.hasMore).toBe(false);
  });

  it("marks every unread notification read across several batches", async () => {
    const many = Array.from({ length: 620 }, (_, i) => notification(`n_${i}`, i + 1));
    const { gateway, wrapper } = setup({ notifications: many });
    const { result } = renderHook(() => useNotifications(), { wrapper });
    await waitFor(() => expect(result.current.unread).toHaveLength(620));

    await act(() => result.current.markAllRead());
    const marked = gateway.calls
      .filter((c) => c.method === "notifications.markRead")
      .flatMap((c) => (c.params as { notificationIds: string[] }).notificationIds);
    expect(new Set(marked).size).toBe(620);
    expect(gateway.world.notifications.every((n) => n.readAt != null)).toBe(true);
    expect(result.current.unread).toHaveLength(0);
  });

  it("marks all read for a notification the client never loaded", async () => {
    const { gateway, wrapper } = setup({ notifications: [notification("n_seen", 1)] });
    const { result } = renderHook(() => useNotifications(), { wrapper });
    await waitFor(() => expect(result.current.unread).toHaveLength(1));
    // Arrives on the Gateway with no event reaching this client (a gap, a reconnect).
    gateway.world.notifications = [...gateway.world.notifications, notification("n_unseen", 5)];
    expect(result.current.all.map((n) => n.id)).toEqual(["n_seen"]);

    await act(() => result.current.markAllRead());
    expect(gateway.world.notifications.every((n) => n.readAt != null)).toBe(true);
    expect(result.current.unread).toHaveLength(0);
  });
});
