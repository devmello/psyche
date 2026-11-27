import type { ApprovalRequest, Message } from "@psyche/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { ApprovalDock } from "../src/chat/ApprovalDock.tsx";
import { ChatThread } from "../src/chat/Thread.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

/**
 * Chat QA round 2: a stopped turn says so and retries in the same chat; an agent message with
 * nothing to show draws no header; a pending approval says one thing; an expired one is a line.
 */

const NOW = Date.parse(FIXTURE_NOW);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };

async function renderThread() {
  // A clock that moves a second per read, so "after" in a transcript means after.
  let tick = 0;
  const clock = () => new Date(NOW + 60_000 + 1000 * tick++).toISOString();
  const gateway = new MockGateway(createFixtureWorld(), { now: clock });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  // A fresh chat: no fixture run is working in it, so Retry is offered.
  const { thread } = await gateway.request(
    "threads.create",
    { kind: "side" },
    { idempotencyKey: `side-${Math.random()}` },
  );
  const threadId = thread.id;
  render(
    <GatewayProvider client={gateway} store={store}>
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
        <ChatThread threadId={threadId} now={NOW} />
      </UiSlotsProvider>
    </GatewayProvider>,
  );
  return { gateway, threadId };
}

describe("a stopped turn", () => {
  it("shows Stopped and a Retry that resends the same message in the same chat", async () => {
    const { gateway, threadId } = await renderThread();
    await screen.findByRole("log", { name: "Conversation" });
    const sent = gateway.commitMessage(threadId, "user", [
      { type: "text", md: "Find me a Thursday slot" },
    ]);
    act(() =>
      gateway.setRun({
        id: "run_stopped_1",
        threadId: threadId,
        status: "cancelled",
        modelRef: "anthropic/claude-sonnet-5-5",
        attempt: 1,
        startedAt: sent.createdAt,
        endedAt: sent.createdAt,
        usage,
      }),
    );
    const line = await screen.findByTestId("run-stopped");
    expect(line.textContent).toContain("Stopped");
    const before = gateway.calls.filter((c) => c.method === "chat.send").length;
    const created = gateway.calls.filter((c) => c.method === "threads.create").length;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(gateway.calls.filter((c) => c.method === "chat.send")).toHaveLength(before + 1),
    );
    const call = gateway.calls.filter((c) => c.method === "chat.send").at(-1);
    expect(call?.params).toMatchObject({
      threadId: threadId,
      content: "Find me a Thursday slot",
    });
    // Same chat: no side chat or fork was made by Retry.
    expect(gateway.calls.filter((c) => c.method === "threads.create")).toHaveLength(created);
    expect(gateway.calls.some((c) => c.method === "threads.fork")).toBe(false);
  });

  it("offers no Retry once the owner has moved on (a later message exists)", async () => {
    const { gateway, threadId } = await renderThread();
    await screen.findByRole("log", { name: "Conversation" });
    const sent = gateway.commitMessage(threadId, "user", [{ type: "text", md: "one" }]);
    act(() =>
      gateway.setRun({
        id: "run_stopped_2",
        threadId: threadId,
        status: "cancelled",
        modelRef: "anthropic/claude-sonnet-5-5",
        attempt: 1,
        startedAt: sent.createdAt,
        endedAt: sent.createdAt,
        usage,
      }),
    );
    await screen.findByTestId("run-stopped");
    act(() => {
      gateway.commitMessage(threadId, "user", [{ type: "text", md: "two" }]);
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(screen.getByTestId("run-stopped").textContent).toContain("Stopped");
  });
});

describe("an agent message with nothing to show", () => {
  it("draws no header while its calls sit in the run's steps, and the reply keeps one", async () => {
    const { gateway, threadId } = await renderThread();
    await screen.findByRole("log", { name: "Conversation" });
    const asked = gateway.commitMessage(threadId, "user", [{ type: "text", md: "Remind me" }]);
    act(() =>
      gateway.setRun({
        id: "run_live_1",
        threadId,
        status: "running",
        modelRef: "anthropic/claude-sonnet-5-5",
        attempt: 1,
        startedAt: asked.createdAt,
        endedAt: null,
        usage,
      }),
    );
    const agent = (blocks: Message["blocks"]) =>
      act(() => {
        gateway.commitMessage(threadId, "agent", blocks, { runId: "run_live_1" });
      });
    const call = (id: string): Message["blocks"][number] => ({
      type: "tool_call",
      toolCallId: id,
      tool: "schedule.create",
      status: "pending",
      level1: "Schedule a reminder",
    });
    agent([call("tc_a")]);
    agent([call("tc_b")]);
    // Positive control: a message with text draws its header.
    agent([{ type: "text", md: "I set it up." }]);
    await screen.findByText("I set it up.");
    expect(screen.getAllByRole("article", { name: /^Wren,/ })).toHaveLength(1);
  });
});

function pendingCard(over: Partial<ApprovalRequest>): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
  if (!base) throw new Error("no pending approval fixture");
  return { ...base, status: "pending", ...over };
}

describe("an expired approval", () => {
  it("collapses to one muted line with no countdown, where a live card shows both", () => {
    const live = pendingCard({ expiresAt: new Date(NOW + 5 * 60_000).toISOString() });
    const { unmount } = render(
      <UiSlotsProvider value={{}}>
        <ApprovalCard approval={live} canAnswer now={NOW} armDelayMs={0} onAnswer={() => {}} />
      </UiSlotsProvider>,
    );
    expect(screen.getByText(/Expires at/)).toBeTruthy();
    expect(screen.queryByTestId("approval-expired")).toBeNull();
    unmount();

    render(
      <UiSlotsProvider value={{}}>
        <ApprovalCard
          approval={{ ...live, expiresAt: new Date(NOW - 1000).toISOString() }}
          canAnswer
          now={NOW}
          armDelayMs={0}
          onAnswer={() => {}}
        />
      </UiSlotsProvider>,
    );
    const line = screen.getByTestId("approval-expired");
    expect(line.textContent).toBe("Expired · nothing was done");
    expect(screen.queryByText(/Expires at/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Allow|Deny)$/ })).toBeNull();
  });

  it("is never the open card in the dock: the live card stays, the lapsed one is a line", async () => {
    const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
    const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
    const base = pendingCard({});
    const thread = base.requestedBy.threadId;
    if (thread == null) throw new Error("fixture approval has no thread");
    gateway.requestApproval(
      pendingCard({
        id: "ap_lapsed",
        summary: "Lapsed ask",
        expiresAt: new Date(NOW - 5000).toISOString(),
      }),
    );
    gateway.requestApproval(
      pendingCard({
        id: "ap_live",
        summary: "Live ask",
        expiresAt: new Date(NOW + 600_000).toISOString(),
      }),
    );
    render(
      <GatewayProvider client={gateway} store={store}>
        <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
          <ApprovalDock threadId={thread} now={NOW} />
        </UiSlotsProvider>
      </GatewayProvider>,
    );
    expect(await screen.findByTestId("approval-expired")).toBeTruthy();
    // A card is open (the live ones), and it is not the lapsed one.
    expect(screen.getByTestId("approval-deck")).toBeTruthy();
    expect(screen.queryByText("Lapsed ask")).toBeNull();
  });
});
