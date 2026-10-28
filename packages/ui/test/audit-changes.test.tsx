import type { AuditChange, Message } from "@psyche/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuditView } from "../src/agent/AuditView.tsx";
import { ChatThread } from "../src/chat/Thread.tsx";
import { type createFixtureWorld, IDS } from "../src/fixtures/index.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

const T = IDS.threads.main;
type World = ReturnType<typeof createFixtureWorld>;

const change = (seq: number, over: Partial<AuditChange> = {}): AuditChange => ({
  seq,
  hash: `sha256:${"a".repeat(64)}`,
  ts: "2026-10-28T10:00:00Z",
  actor: { type: "job", name: "profile-learning" },
  category: "memory",
  threadId: T,
  runId: "run_chip",
  tool: "profile-learning",
  target: { path: "USER.md" },
  action: "update",
  outcome: "ok",
  hasDiff: true,
  stats: { added: 1, removed: 0 },
  ...over,
});

const DIFF = "--- a/USER.md\n+++ b/USER.md\n@@ -1,1 +1,2 @@\n # User\n+- Prefers tea over coffee";

function agentMessage(): Message {
  return {
    id: "m_chip",
    threadId: T,
    seq: 1,
    role: "agent",
    blocks: [{ type: "text", md: "Noted." }],
    providerNative: null,
    provenance: "agent",
    replyToMessageId: null,
    channelRef: null,
    runId: "run_chip",
    createdAt: "2026-10-28T10:00:00Z",
  } as Message;
}

function seeded(w: World, changes: AuditChange[]) {
  w.messages = w.messages.filter((m) => m.threadId !== T);
  w.messages.push(agentMessage());
  w.auditChanges = changes.map((c) => ({ change: c, ...(c.hasDiff ? { diff: DIFF } : {}) }));
}

describe("change chip", () => {
  it("shows 'Changed 1 file · USER.md' from stored records and expands to the diff", async () => {
    render(
      <StoryWorld edit={(w) => seeded(w, [change(5)])}>
        <div style={{ height: 900 }}>
          <ChatThread threadId={T} now={STORY_NOW} />
        </div>
      </StoryWorld>,
    );
    const chip = await screen.findByRole("button", { name: /Changed 1 file · USER\.md/ });
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByText(/Prefers tea over coffee/)).toBeTruthy());
    expect(screen.getByRole("link", { name: "Open in Timeline" })).toBeTruthy();
  });

  it("shows nothing for a turn without changes", async () => {
    render(
      <StoryWorld edit={(w) => seeded(w, [change(5, { runId: "run_other" })])}>
        <div style={{ height: 900 }}>
          <ChatThread threadId={T} now={STORY_NOW} />
        </div>
      </StoryWorld>,
    );
    await screen.findByText("Noted.");
    expect(screen.queryByTestId("change-chip")).toBeNull();
  });
});

describe("audit view", () => {
  const world = (w: World) =>
    seeded(w, [
      change(7, {
        category: "file",
        actor: { type: "agent" },
        target: { path: "/tmp/a.md" },
        tool: "write_file",
        action: "create",
      }),
      change(6, {
        category: "command",
        actor: { type: "agent" },
        target: { path: "ls -la" },
        tool: "exec_host",
        action: "exec",
        hasDiff: false,
      }),
      change(5),
    ]);

  it("lists entries with actor and target, filters by type, and shows the chain status", async () => {
    render(
      <StoryWorld edit={world}>
        <AuditView now={Date.parse("2026-10-28T10:05:00Z")} />
      </StoryWorld>,
    );
    await screen.findByText("Verified");
    expect(screen.getByText(/create · \/tmp\/a\.md/)).toBeTruthy();
    expect(screen.getByText(/exec · ls -la/)).toBeTruthy();
    expect(screen.getByText(/update · USER\.md/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Commands" }));
    await waitFor(() => expect(screen.queryByText(/create · \/tmp\/a\.md/)).toBeNull());
    expect(screen.getByText(/exec · ls -la/)).toBeTruthy();
    expect(screen.queryByText(/update · USER\.md/)).toBeNull();
  });

  it("flags a broken chain", async () => {
    render(
      <StoryWorld
        edit={(w) => {
          world(w);
          w.auditVerified = false;
        }}
      >
        <AuditView />
      </StoryWorld>,
    );
    await screen.findByText(/Chain broken at entry 3/);
  });

  it("expands an entry to its diff", async () => {
    render(
      <StoryWorld edit={world}>
        <AuditView />
      </StoryWorld>,
    );
    const row = await screen.findByRole("button", { name: /update · USER\.md/ });
    fireEvent.click(row);
    await waitFor(() =>
      expect(within(document.body).getByText(/Prefers tea over coffee/)).toBeTruthy(),
    );
  });
});
