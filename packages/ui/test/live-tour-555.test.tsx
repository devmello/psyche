import type { Block } from "@psyche/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentHeader } from "../src/agent/AgentHeader.tsx";
import { withoutRepeatedApprovals } from "../src/blocks/MessageBlocks.tsx";
import { ToolRun } from "../src/blocks/ToolRun.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { formatPast } from "../src/shell/ThreadList.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

describe("agent header status (#555)", () => {
  it("says the state once and reads Working while a chat turn runs", async () => {
    const ref: { gateway?: MockGateway } = {};
    render(
      <StoryWorld
        edit={(w) => {
          // Nothing else going on: no tasks, approvals or questions.
          w.tasks = [];
          w.approvals = [];
          w.inputRequests = [];
          w.runs = w.runs.map((r) => ({ ...r, status: "done" as const }));
          w.threads = w.threads.map((th) => ({
            ...th,
            thread: { ...th.thread, activeWriterRunId: null },
          }));
        }}
        onGateway={(g) => {
          ref.gateway = g;
        }}
      >
        <AgentHeader onOpenSheet={() => {}} />
      </StoryWorld>,
    );
    const status = await screen.findByTestId("agent-status");
    await waitFor(() => expect(status.textContent).toBe("Idle"));
    expect(status.getAttribute("role")).toBe("status");

    const base = ref.gateway?.world.runs[0];
    if (base === undefined || ref.gateway === undefined) throw new Error("fixture runs missing");
    const gateway = ref.gateway;
    act(() =>
      gateway.setRun({
        ...base,
        id: "run_555",
        threadId: IDS.threads.main,
        status: "running",
        endedAt: null,
        error: null,
      }),
    );
    await waitFor(() => expect(status.textContent).toBe("Working…"));
    expect(status.textContent?.match(/working/gi)).toHaveLength(1);
  });
});

describe("approval blocks (#555)", () => {
  it("keeps one block per approval", () => {
    const blocks: Block[] = [
      { type: "tool_call", toolCallId: "tc1", tool: "browser.open_tab", status: "ok", level1: "x" },
      { type: "approval", approvalId: "ap1" },
      { type: "approval", approvalId: "ap1" },
      { type: "approval", approvalId: "ap2" },
    ];
    expect(withoutRepeatedApprovals(blocks).map((b) => b.type)).toEqual([
      "tool_call",
      "approval",
      "approval",
    ]);
    const clean = blocks.slice(0, 2);
    expect(withoutRepeatedApprovals(clean)).toBe(clean);
  });
});

describe("thread list time (#555)", () => {
  it("never shows a last message in the future", () => {
    const now = Date.parse(FIXTURE_NOW);
    expect(formatPast(new Date(now + 4 * 60_000).toISOString(), now)).toBe("just now");
    expect(formatPast(new Date(now - 14 * 60_000).toISOString(), now)).toBe("14 min ago");
  });
});

describe("tool run summary (#555)", () => {
  it("names how many failed, without a stray comma", () => {
    render(
      <ToolRun
        items={[
          {
            block: {
              type: "tool_call",
              toolCallId: "tc1",
              tool: "browser.open_tab",
              status: "failed",
              level1: "Open the page",
            },
          },
        ]}
      />,
    );
    const button = screen.getByRole("button");
    expect(button.textContent).toMatch(/1 action · browser · 1 failed$/);
    expect(button.textContent).not.toContain(",");
  });
});
