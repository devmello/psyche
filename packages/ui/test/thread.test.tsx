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

describe("slash commands (C9)", () => {
  const box = () => screen.findByRole("textbox", { name: "Message Wren" });

  it("shows every command while typing / and completes the highlighted one with Return", async () => {
    renderMain();
    await userEvent.type(await box(), "/");
    const menu = await screen.findByRole("listbox", { name: "Commands" });
    expect(within(menu).getAllByRole("option")).toHaveLength(12);
    await userEvent.type(await box(), "rem");
    expect(
      within(screen.getByRole("listbox", { name: "Commands" })).getAllByRole("option"),
    ).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(((await box()) as HTMLTextAreaElement).value).toBe("/remember ");
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
  });

  it("/remember notes the fact in today's memory", async () => {
    const { gateway } = renderMain();
    await userEvent.type(await box(), "/remember I prefer aisle seats{Enter}");
    await waitFor(() =>
      expect(gateway.calls.find((c) => c.method === "memory.remember")?.params).toEqual({
        text: "I prefer aisle seats",
      }),
    );
    expect(await screen.findByText(/^Noted in memory\//)).toBeTruthy();
    expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(false);
  });

  it("/forget previews what goes and forgets only after confirmation", async () => {
    const { gateway } = renderMain();
    const subject = gateway.world.memoryClaims[0]?.text.split(" ").slice(0, 2).join(" ") ?? "x";
    await userEvent.type(await box(), `/forget ${subject}{Enter}`);
    const notice = await screen.findByTestId("command-notice");
    const calls = () => gateway.calls.filter((c) => c.method === "memory.forget");
    await waitFor(() => expect(calls()).toHaveLength(1));
    expect(calls()[0]?.params).toEqual({ subject, dryRun: true });
    await userEvent.click(within(notice).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(calls()).toHaveLength(2));
    expect(calls()[1]?.params).toEqual({ subject });
    expect(await screen.findByText(`Forgot "${subject}".`)).toBeTruthy();
  });

  it("/model and /plan update the thread; /status reports it", async () => {
    const { gateway } = renderMain();
    await userEvent.type(await box(), "/model anthropic/claude-sonnet-5-5{Enter}");
    expect(
      await screen.findByText("This thread now uses anthropic/claude-sonnet-5-5."),
    ).toBeTruthy();
    await userEvent.type(await box(), "/plan{Enter}");
    expect(await screen.findByText(/^Plan mode/)).toBeTruthy();
    const updates = gateway.calls.filter((c) => c.method === "threads.update").map((c) => c.params);
    expect(updates).toEqual([
      { threadId: IDS.threads.main, modelRef: "anthropic/claude-sonnet-5-5" },
      { threadId: IDS.threads.main, permissionMode: "plan" },
    ]);
    await userEvent.type(await box(), "/status{Enter}");
    const notice = await screen.findByTestId("command-notice");
    await waitFor(() => expect(notice.textContent).toContain("Mode: plan"));
    expect(notice.textContent).toContain("Model: anthropic/claude-sonnet-5-5");
  });

  it("an unknown command explains itself and sends nothing; // sends a literal slash", async () => {
    const { gateway } = renderMain();
    await userEvent.type(await box(), "/frobnicate{Escape}{Enter}");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(false);
    await userEvent.type(await box(), "//etc/hosts is a file{Enter}");
    await waitFor(() =>
      expect(gateway.calls.find((c) => c.method === "chat.send")?.params).toMatchObject({
        content: "/etc/hosts is a file",
      }),
    );
  });

  it("/new opens a side chat and /stop says when nothing runs", async () => {
    const { gateway, navigated } = renderMain();
    await userEvent.type(await box(), "/stop{Enter}");
    expect(await screen.findByText("Nothing is running in this chat.")).toBeTruthy();
    await userEvent.type(await box(), "/new{Enter}");
    await waitFor(() => expect(navigated).toHaveLength(1));
    expect(gateway.calls.find((c) => c.method === "threads.create")?.params).toEqual({
      kind: "side",
    });
  });
});
