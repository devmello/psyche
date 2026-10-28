import type { Block, Message } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { blocksToShow, indexThreadBlocks } from "../src/blocks/thread-blocks.tsx";
import { ChatThread } from "../src/chat/Thread.tsx";
import { type createFixtureWorld, IDS } from "../src/fixtures/index.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

const T = IDS.threads.main;

function msg(id: string, seq: number, blocks: Block[]): Message {
  return {
    id,
    threadId: T,
    seq,
    role: "agent",
    blocks,
    providerNative: null,
    provenance: "agent",
    replyToMessageId: null,
    channelRef: null,
    runId: "run_569",
    createdAt: "2026-10-19T10:00:00Z",
  };
}

/** The transcript #569 describes: the call before the pause, the approval, the resumed call. */
function pausedTurn(approvalId: string): Message[] {
  return [
    msg("m569_a", 900, [
      { type: "text", md: "Checking the current Node.js LTS." },
      {
        type: "tool_call",
        toolCallId: "tc_search",
        tool: "web.search",
        status: "ok",
        level1: 'Searched the web for "current Node.js LTS version"',
      },
      {
        type: "tool_call",
        toolCallId: "tc_fetch",
        tool: "web.fetch",
        status: "pending",
        level1: "Calling web.fetch",
      },
      { type: "approval", approvalId },
    ]),
    msg("m569_b", 901, [
      { type: "approval", approvalId },
      {
        type: "tool_call",
        toolCallId: "tc_fetch",
        tool: "web.fetch",
        status: "ok",
        level1: "Read nodejs.org",
      },
      { type: "text", md: "Node.js 26 is the current LTS." },
    ]),
  ];
}

describe("tool rows across an approval pause (#569)", () => {
  it("shows each call once, at its first place, in its latest state, and each approval once", () => {
    const [a, b] = pausedTurn("ap_569");
    if (a === undefined || b === undefined) throw new Error("fixture");
    const index = indexThreadBlocks([a, b]);
    const first = blocksToShow(a, index);
    const second = blocksToShow(b, index);
    const calls = (blocks: readonly Block[]) =>
      blocks.flatMap((x) => (x.type === "tool_call" ? [`${x.toolCallId}:${x.status}`] : []));
    expect(calls(first)).toEqual(["tc_search:ok", "tc_fetch:ok"]);
    expect(calls(second)).toEqual([]);
    expect(first.filter((x) => x.type === "approval")).toHaveLength(1);
    expect(second.filter((x) => x.type === "approval")).toHaveLength(0);
    // Messages with nothing to fold come back untouched.
    const plain = msg("m_plain", 5, [{ type: "text", md: "hi" }]);
    expect(blocksToShow(plain, index)).toBe(plain.blocks);
  });

  it("renders one row going pending → ok and one receipt in the thread", async () => {
    render(
      <StoryWorld
        edit={(w: ReturnType<typeof createFixtureWorld>) => {
          const base = w.approvals.find((x) => x.id === IDS.approvals.sendEmail);
          if (base === undefined) throw new Error("fixture approval");
          w.approvals.push({
            ...base,
            id: "ap_569",
            summary: "Read nodejs.org",
            status: "approved",
            scopeGranted: "once",
            requestedBy: { ...base.requestedBy, threadId: T },
          });
          w.messages.push(...pausedTurn("ap_569"));
        }}
      >
        <div style={{ height: 900 }}>
          <ChatThread threadId={T} now={STORY_NOW} />
        </div>
      </StoryWorld>,
    );
    const log = await screen.findByRole("log", { name: "Conversation" });
    await within(log).findByText("Read nodejs.org");
    expect(within(log).queryByText("Calling web.fetch")).toBeNull();
    // One folded run (both calls), not a second group for the resumed call.
    expect(within(log).getAllByRole("button", { name: /2 actions · web/ })).toHaveLength(1);
    expect(within(log).queryByRole("button", { name: /^1 action · web/ })).toBeNull();
    await waitFor(() =>
      expect(within(log).getAllByText(/Allowed once: Read nodejs\.org/)).toHaveLength(1),
    );
  });
});
