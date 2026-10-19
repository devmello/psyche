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

function renderMain() {
  const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  const navigated: string[] = [];
  render(
    <GatewayProvider client={gateway} store={store}>
      <UiSlotsProvider
        value={{ persona: { name: "Wren", creature: "moth" }, navigate: (r) => navigated.push(r) }}
      >
        <ChatThread threadId={IDS.threads.main} now={NOW} />
      </UiSlotsProvider>
    </GatewayProvider>,
  );
  return { gateway, navigated };
}

describe("reply-to and edit (E5)", () => {
  it("a reply sends replyToMessageId to chat.send", async () => {
    const { gateway } = renderMain();
    const article = (await screen.findAllByRole("article", { name: /^You, / }))[0] as HTMLElement;
    await userEvent.click(within(article).getByRole("button", { name: "Message actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Reply" }));
    expect(await screen.findByRole("button", { name: "Remove quote" })).toBeTruthy();
    await userEvent.type(screen.getByRole("textbox", { name: "Message Wren" }), "Yes, that{Enter}");
    await waitFor(() => expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(true));
    expect(gateway.calls.find((c) => c.method === "chat.send")?.params).toMatchObject({
      threadId: IDS.threads.main,
      content: "Yes, that",
      replyToMessageId: IDS.messages.mainUser,
    });
  });

  it("edit and resend forks before the message, sends the edit there and opens the fork", async () => {
    const { gateway, navigated } = renderMain();
    const article = (await screen.findAllByRole("article", { name: /^You, / }))[0] as HTMLElement;
    await userEvent.click(within(article).getByRole("button", { name: "Message actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit and resend" }));
    const box = await screen.findByRole("textbox", { name: /Edits are sent in a side chat/ });
    await userEvent.clear(box);
    await userEvent.type(box, "Book the dentist for Thursday instead");
    await userEvent.click(screen.getByRole("button", { name: "Resend as a side chat" }));
    await waitFor(() => expect(navigated).toHaveLength(1));
    const fork = gateway.calls.find((c) => c.method === "threads.fork");
    expect(fork?.params).toEqual({
      threadId: IDS.threads.main,
      messageId: IDS.messages.mainBootstrap,
    });
    const sent = gateway.calls.find((c) => c.method === "chat.send");
    const forkedId = navigated[0]?.replace("/chat/", "");
    expect(sent?.params).toMatchObject({
      threadId: forkedId,
      content: "Book the dentist for Thursday instead",
    });
    // The original thread keeps its transcript: the edit went to the fork only.
    expect(
      gateway.world.messages.some(
        (m) => m.threadId === IDS.threads.main && JSON.stringify(m.blocks).includes("Thursday"),
      ),
    ).toBe(false);
  });
});

describe("incognito and view modes (E9, E11)", () => {
  it("/incognito starts a memory-only side chat and sends the rest there", async () => {
    const { gateway, navigated } = renderMain();
    const box = await screen.findByRole("textbox", { name: "Message Wren" });
    await userEvent.type(box, "/incognito what did the doctor say{Enter}");
    await waitFor(() => expect(navigated).toHaveLength(1));
    const created = gateway.calls.find((c) => c.method === "threads.create");
    expect(created?.params).toEqual({ kind: "incognito", parentThreadId: IDS.threads.main });
    const sent = gateway.calls.find((c) => c.method === "chat.send");
    expect(sent?.params).toMatchObject({
      threadId: navigated[0]?.replace("/chat/", ""),
      content: "what did the doctor say",
    });
    const forkedId = navigated[0]?.replace("/chat/", "");
    expect(gateway.world.threads.find((t) => t.thread.id === forkedId)?.thread.kind).toBe(
      "incognito",
    );
  });

  it("a controlled disclosure level reports ⌃O cycles to the host", async () => {
    const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
    const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
    const levels: number[] = [];
    render(
      <GatewayProvider client={gateway} store={store}>
        <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
          <ChatThread
            threadId={IDS.threads.main}
            now={NOW}
            disclosure={2}
            onDisclosureChange={(l) => levels.push(l)}
          />
        </UiSlotsProvider>
      </GatewayProvider>,
    );
    await screen.findByRole("log", { name: "Conversation" });
    await userEvent.keyboard("{Control>}o{/Control}");
    expect(levels).toEqual([0]);
  });
});
