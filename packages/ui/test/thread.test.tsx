import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ChatThread } from "../src/chat/Thread.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

const NOW = Date.parse(FIXTURE_NOW);

function renderThread() {
  const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  const utils = render(
    <GatewayProvider client={gateway} store={store}>
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
        <ChatThread threadId={IDS.threads.dentist} now={NOW} />
      </UiSlotsProvider>
    </GatewayProvider>,
  );
  return { gateway, store, ...utils };
}

describe("ChatThread", () => {
  it("renders the transcript, the approval dock and the composer", async () => {
    renderThread();
    expect(await screen.findByRole("log", { name: "Conversation" })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole("article").length).toBeGreaterThan(3));
    // Approvals sit in the dock, outside the message stream.
    const log = screen.getByRole("log");
    expect(within(log).queryByRole("group", { name: /email/i })).toBeNull();
    expect(await screen.findAllByText("Approval needed")).not.toHaveLength(0);
    expect(screen.getByRole("textbox", { name: "Message Wren" })).toBeTruthy();
  });

  it("sends a message through chat.send", async () => {
    const { gateway } = renderThread();
    const box = await screen.findByRole("textbox", { name: "Message Wren" });
    await waitFor(() => expect(gateway.calls.some((c) => c.method === "chat.history")).toBe(true));
    const runsBusy = gateway.world.runs.some(
      (r) => r.threadId === IDS.threads.dentist && r.status === "running",
    );
    await userEvent.type(box, "Also check Thursday{Enter}");
    if (runsBusy) {
      expect(await screen.findByText(/Queued/)).toBeTruthy();
    } else {
      await waitFor(() => expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(true));
    }
  });
});

describe("ChatThread layout states", () => {
  it("shows the empty state in a chat without messages, then the conversation", async () => {
    const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
    const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
    const { thread } = await gateway.request(
      "threads.create",
      { kind: "side" },
      { idempotencyKey: "empty-side" },
    );
    render(
      <GatewayProvider client={gateway} store={store}>
        <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
          <ChatThread threadId={thread.id} now={NOW} />
        </UiSlotsProvider>
      </GatewayProvider>,
    );
    expect(await screen.findByTestId("chat-empty")).toBeTruthy();
    expect(screen.getByText("Nothing here yet. Ask Wren something below to start.")).toBeTruthy();
    // Short conversations are anchored to the bottom of the column, next to the composer.
    expect(screen.getByTestId("conversation-column").className).toContain("justify-end");
  });

  it("has no empty state once there are messages", async () => {
    renderThread();
    await waitFor(() => expect(screen.getAllByRole("article").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("chat-empty")).toBeNull();
  });
});
