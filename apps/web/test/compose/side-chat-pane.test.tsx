// @vitest-environment happy-dom

import { GatewayProvider, UiSlotsProvider } from "@psyche/ui";
import { MockGateway } from "@psyche/ui/testing";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureWorld, FIXTURE_NOW } from "../../../../packages/ui/src/fixtures/index.ts";
import { SideChatPane } from "../../src/compose/side-chat.tsx";

afterEach(cleanup);

/** The side chat pane over the kit's mock Gateway: the chat itself, and where it came from. */
async function open() {
  const gw = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
  const parent = (await gw.request("threads.list", {})).threads.find(
    (e) => e.thread.title === "Dentist booking",
  );
  if (parent === undefined) throw new Error("fixture thread missing");
  const { thread } = await gw.request(
    "threads.create",
    { kind: "side", title: "About Dentist booking", parentThreadId: parent.thread.id },
    { idempotencyKey: "k1" },
  );
  const onExpand = vi.fn();
  render(
    <GatewayProvider client={gw}>
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
        <SideChatPane threadId={thread.id} onExpand={onExpand} />
      </UiSlotsProvider>
    </GatewayProvider>,
  );
  return { gw, thread, onExpand };
}

describe("side chat pane", () => {
  it("names where the chat came from and expands", async () => {
    const { onExpand } = await open();
    expect((await screen.findByTestId("side-chat-from")).textContent).toBe(
      "Side chat about Dentist booking",
    );
    fireEvent.click(screen.getByRole("button", { name: /Expand/ }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("shows an answer once", async () => {
    const { gw, thread } = await open();
    await screen.findByTestId("side-chat-from");
    await act(async () => {
      await gw.streamReply(thread.id, "Your dentist appointment is Friday at 3pm.");
    });
    await waitFor(() => expect(screen.queryAllByText(/Friday at 3pm/)).toHaveLength(1));
  });
});
