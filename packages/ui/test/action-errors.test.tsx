import type { Message } from "@psyche/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalsPanel } from "../src/agent/ApprovalsPanel.tsx";
import { MessageBlocks } from "../src/blocks/MessageBlocks.tsx";
import { Toaster } from "../src/components/ui/sonner.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { PEOPLE_IDS } from "../src/fixtures/people.ts";
import { ConnectedEntityCard } from "../src/people/ConnectedEntityCard.tsx";
import { FeedScreen } from "../src/screens/feed/FeedScreen.tsx";
import { SearchScreen } from "../src/screens/search/SearchScreen.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/**
 * A user action whose Gateway call fails says so, in a toast or next to the control, instead of
 * doing nothing. Each case makes the call reject and reads the error the owner sees.
 */

const NOW = "2026-10-28T10:00:00Z";

/** The failure text is visible on screen (a toast renders outside the component's own tree). */
async function expectShown(text: string): Promise<void> {
  await waitFor(() => expect(document.body.textContent ?? "").toContain(text));
}

function gatewayOf(ref: { current?: MockGateway }) {
  return () => {
    if (ref.current === undefined) throw new Error("gateway not ready");
    return ref.current;
  };
}

describe("failed user actions say why", () => {
  it("export a person's data shows the Gateway's reason", async () => {
    const ref: { current?: MockGateway } = {};
    const user = userEvent.setup();
    render(
      <StoryWorld onGateway={(g) => (ref.current = g)}>
        <ConnectedEntityCard id={PEOPLE_IDS.samLee} now={STORY_NOW} />
      </StoryWorld>,
    );
    await screen.findByRole("article", { name: "Sam Lee" });
    await user.click(screen.getByRole("button", { name: "More for Sam Lee" }));
    gatewayOf(ref)().failNext("memory.entities.export", "unavailable", "the vault is locked");
    await user.click(await screen.findByRole("menuitem", { name: "Export everything…" }));
    await expectShown("Couldn't export this person's data (the vault is locked).");
  });

  it("revoking a standing approval that fails says why and keeps it listed", async () => {
    const ref: { current?: MockGateway } = {};
    const user = userEvent.setup();
    render(
      <StoryWorld onGateway={(g) => (ref.current = g)}>
        <ApprovalsPanel now={STORY_NOW} />
      </StoryWorld>,
    );
    await user.click(await screen.findByRole("button", { name: /^Standing permissions/ }));
    const revoke = (await screen.findAllByRole("button", { name: /^Revoke/ }))[0];
    if (revoke === undefined) throw new Error("no standing grant to revoke");
    const label = revoke.getAttribute("aria-label") ?? "";
    gatewayOf(ref)().failNext("grants.revoke", "unavailable", "the grant store is locked");
    await user.click(revoke);
    await expectShown(
      "Couldn't revoke this approval (the grant store is locked). It's still in place.",
    );
    // The grant is still listed, so the owner can try again.
    expect(screen.getByRole("button", { name: label })).toBeTruthy();
  });

  it("undoing feedback that fails says why and the post stays liked", async () => {
    const ref: { current?: MockGateway } = {};
    const user = userEvent.setup();
    render(
      <StoryWorld onGateway={(g) => (ref.current = g)}>
        <FeedScreen now={STORY_NOW} />
      </StoryWorld>,
    );
    const like = (await screen.findAllByRole("button", { name: "Like" }))[0];
    if (like === undefined) throw new Error("no feed post to like");
    await user.click(like);
    gatewayOf(ref)().failNext("feed.feedback", "unavailable", "the feed store is locked");
    await user.click(await screen.findByText("Undo"));
    await expectShown(
      "Psyche couldn't save that feedback (the feed store is locked). Nothing was changed.",
    );
    // The undo never took effect, so the post is still liked.
    expect(screen.getAllByRole("button", { name: "Like" })[0]?.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("rebuilding the search index that fails says why", async () => {
    const user = userEvent.setup();
    const ref: { current?: MockGateway } = {};
    render(
      <StoryWorld onGateway={(g) => (ref.current = g)}>
        <SearchScreen debounceMs={0} now={STORY_NOW} />
      </StoryWorld>,
    );
    await user.type(screen.getByRole("combobox"), "zzqxvnothing");
    const rebuild = await screen.findByRole("button", { name: "Rebuild search index" });
    gatewayOf(ref)().failNext("search.reindex", "unavailable", "the index is busy");
    await user.click(rebuild);
    await expectShown("Couldn't rebuild the search index (the index is busy).");
  });

  it("stopping a research run that fails says why and the run keeps showing as running", async () => {
    const gateway = new MockGateway({ threads: [] }, { now: () => NOW });
    const store = new GatewayStore(gateway, { now: () => NOW });
    store.update((s) => ({
      ...s,
      toolCalls: { tc1: { id: "tc1", runId: "run1", tool: "research_run" } as never },
      runs: { run1: { id: "run1", threadId: "thr_main", status: "running" } as never },
    }));
    // Only the stop call fails; other calls the card makes on mount succeed, as in production.
    const cancel = vi.spyOn(store, "call").mockImplementation((method: string) => {
      if (method === "chat.cancel") return Promise.reject(new Error("the run already finished"));
      return Promise.resolve({ cancelled: true } as never);
    });
    const user = userEvent.setup();
    const message = {
      id: "m1",
      threadId: "thr_main",
      role: "agent",
      blocks: [
        {
          type: "tool_call",
          toolCallId: "tc1",
          tool: "research_run",
          status: "running",
          level1: "Run",
        },
      ],
    } as unknown as Message;
    render(
      <>
        <GatewayProvider client={gateway} store={store}>
          <MessageBlocks message={message} />
        </GatewayProvider>
        <Toaster />
      </>,
    );
    // The card draws from research.progress events; Stop appears once one has arrived.
    act(() => {
      gateway.emit("research.progress", {
        toolCallId: "tc1",
        event: { type: "step", step: "read" },
      });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop research" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Stop research" }));
    expect(cancel).toHaveBeenCalledWith("chat.cancel", { threadId: "thr_main" });
    await expectShown("Couldn't stop the research (the run already finished). It's still running.");
    expect(screen.getByRole("button", { name: "Stop research" })).toBeTruthy();
  });
});
