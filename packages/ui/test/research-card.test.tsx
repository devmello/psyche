import type { Message } from "@psyche/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageBlocks } from "../src/blocks/MessageBlocks.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";

const NOW = "2026-10-28T10:00:00Z";

function message(status: "running" | "ok"): Message {
  return {
    id: "m1",
    threadId: "thr_main",
    role: "agent",
    blocks: [{ type: "tool_call", toolCallId: "tc1", tool: "research_run", status, level1: "Run" }],
  } as unknown as Message;
}

function setup(status: "running" | "ok" = "running") {
  const gateway = new MockGateway({ threads: [] }, { now: () => NOW });
  const store = new GatewayStore(gateway, { now: () => NOW });
  store.update((s) => ({
    ...s,
    toolCalls: { tc1: { id: "tc1", runId: "run1", tool: "research_run" } as never },
    runs: { run1: { id: "run1", threadId: "thr_main", status: "running" } as never },
  }));
  const call = vi.spyOn(store, "call").mockResolvedValue({ cancelled: true } as never);
  render(
    <GatewayProvider client={gateway} store={store}>
      <MessageBlocks message={message(status)} />
    </GatewayProvider>,
  );
  return { gateway, call };
}

describe("research progress in the transcript", () => {
  it("draws the card from research.progress events and Stop cancels the run", async () => {
    const { gateway, call } = setup();
    expect(screen.queryByTestId("research-progress")).toBeNull();
    act(() => {
      gateway.emit("research.progress", {
        toolCallId: "tc1",
        event: {
          type: "plan",
          plan: {
            subQuestions: [{ id: "s1", question: "How long do solar panels last?" }],
            includeLocal: false,
            estimatedTokens: 40000,
          },
        },
      });
      gateway.emit("research.progress", {
        toolCallId: "tc1",
        event: { type: "step", step: "read" },
      });
    });
    await waitFor(() => expect(screen.getByTestId("research-progress")).toBeTruthy());
    expect(screen.getByText("How long do solar panels last?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Stop research" }));
    expect(call).toHaveBeenCalledWith("chat.cancel", { threadId: "thr_main" });
  });

  it("does not leave a finished call spinning without a done event", async () => {
    const { gateway } = setup("ok");
    act(() => {
      gateway.emit("research.progress", {
        toolCallId: "tc1",
        event: { type: "step", step: "read" },
      });
    });
    await waitFor(() => expect(screen.getByTestId("research-progress")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Stop research" })).toBeNull();
  });
});
