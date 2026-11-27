import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// A render spy around MessageBlocks: it renders once per MessageView render, keyed by message id.
const renders = vi.hoisted(() => new Map<string, number>());
vi.mock("../src/blocks/MessageBlocks.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/blocks/MessageBlocks.tsx")>();
  return {
    ...actual,
    MessageBlocks: (props: Parameters<typeof actual.MessageBlocks>[0]) => {
      renders.set(props.message.id, (renders.get(props.message.id) ?? 0) + 1);
      return actual.MessageBlocks(props);
    },
  };
});

import { ChatThread } from "../src/chat/Thread.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { addLongConversation } from "../src/fixtures/long-thread.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

const NOW = Date.parse(FIXTURE_NOW);
const STREAM_ID = "msg_stream_rc";

describe("ChatThread render counts while streaming", () => {
  it("re-renders only the streaming row on a delta, not the finished rows", async () => {
    const world = createFixtureWorld();
    addLongConversation(world, IDS.threads.main, 40);
    const gateway = new MockGateway(world, { now: () => FIXTURE_NOW });
    const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
    render(
      <GatewayProvider client={gateway} store={store}>
        <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
          <div className="flex h-[600px] flex-col">
            <ChatThread threadId={IDS.threads.main} now={NOW} />
          </div>
        </UiSlotsProvider>
      </GatewayProvider>,
    );
    const log = await screen.findByRole("log", { name: "Conversation" });
    await waitFor(() =>
      expect(within(log).getAllByRole("article").length).toBeGreaterThanOrEqual(40),
    );
    const delta = (d: string) =>
      act(() =>
        gateway.emit("chat.delta", { threadId: IDS.threads.main, messageId: STREAM_ID, delta: d }),
      );
    // Words are wrapped in spans, so match on the paragraph's text.
    const para = (re: RegExp) =>
      within(log).findByText((_, el) => el?.tagName === "P" && re.test(el.textContent ?? ""));
    delta("Looking");
    await para(/Looking/);
    await new Promise((r) => setTimeout(r, 50));
    const finished = [...renders.keys()].filter((id) => id !== STREAM_ID);
    expect(finished.length).toBeGreaterThanOrEqual(40);
    const before = new Map(renders);

    for (const d of [" at", " your", " calendar"]) {
      delta(d);
      await new Promise((r) => setTimeout(r, 30));
    }
    await para(/Looking at your calendar/);

    // Positive control: the streaming row did re-render.
    expect(renders.get(STREAM_ID) ?? 0).toBeGreaterThan(before.get(STREAM_ID) ?? 0);
    for (const id of finished) expect(renders.get(id), id).toBe(before.get(id));
  });
});
