import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ChatThread } from "../src/chat/Thread.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

const NOW = Date.parse(FIXTURE_NOW);
const A = IDS.threads.main;
const B = IDS.threads.dentist;

/** The app remounts the chat per thread; so does this harness. */
function Switcher() {
  const [id, setId] = useState<string>(A);
  return (
    <>
      <button type="button" onClick={() => setId(A)}>
        go-a
      </button>
      <button type="button" onClick={() => setId(B)}>
        go-b
      </button>
      <ChatThread key={id} threadId={id} now={NOW} />
    </>
  );
}

function mount() {
  const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  render(
    <GatewayProvider client={gateway} store={store}>
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
        <Switcher />
      </UiSlotsProvider>
    </GatewayProvider>,
  );
  return { gateway, store };
}

const box = () =>
  screen.findByRole("textbox", { name: "Message Wren" }) as Promise<HTMLTextAreaElement>;
const go = async (name: "go-a" | "go-b") => {
  await userEvent.click(screen.getByRole("button", { name }));
};
const pdf = (name: string) =>
  new File([new Uint8Array([37, 80, 68, 70])], name, { type: "application/pdf" });

async function attach(file: File) {
  const input = (await screen.findByTestId("attach-input")) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe("drafts survive a thread switch", () => {
  it("keeps the typed text A -> B -> A, and B stays empty", async () => {
    mount();
    await userEvent.type(await box(), "half a thought");
    await go("go-b");
    await waitFor(async () => expect((await box()).value).toBe(""));
    await userEvent.type(await box(), "other thread");
    await go("go-a");
    await waitFor(async () => expect((await box()).value).toBe("half a thought"));
    await go("go-b");
    await waitFor(async () => expect((await box()).value).toBe("other thread"));
  });

  it("forgets the draft once it is sent", async () => {
    const { gateway } = mount();
    await userEvent.type(await box(), "send me{Enter}");
    await waitFor(() => expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(true));
    await go("go-b");
    await go("go-a");
    await waitFor(async () => expect((await box()).value).toBe(""));
  });

  it("keeps the reply target", async () => {
    mount();
    const menus = await screen.findAllByRole("button", { name: "Message actions" });
    await userEvent.click(menus[0] as HTMLElement);
    await userEvent.click(await screen.findByRole("menuitem", { name: /reply/i }));
    expect(await screen.findByRole("button", { name: /remove.*quote|quote/i })).toBeTruthy();
    await go("go-b");
    await go("go-a");
    await waitFor(() => expect(screen.getAllByText(/quoting/i).length).toBeGreaterThan(0));
  });

  it("keeps an attachment chip, and an upload that finishes while away", async () => {
    mount();
    await attach(pdf("brief.pdf"));
    const chips = await screen.findByTestId("attach-chips");
    expect(within(chips).getByText("brief.pdf")).toBeTruthy();
    await go("go-b");
    expect(screen.queryByTestId("attach-chips")).toBeNull();
    await go("go-a");
    const back = await screen.findByTestId("attach-chips");
    expect(within(back).getByText("brief.pdf")).toBeTruthy();
    await waitFor(() => expect(back.querySelector("[data-status=ready]")).not.toBeNull());
  });
});

describe("a failed attachment", () => {
  it("blocks sending, with a hint, until it is retried or removed", async () => {
    const { gateway } = mount();
    gateway.failNext("library.upload", "internal", "disk full");
    await attach(pdf("big.pdf"));
    const chips = await screen.findByTestId("attach-chips");
    await waitFor(() => expect(chips.querySelector("[data-status=error]")).not.toBeNull());
    expect(screen.getByTestId("attach-blocked").textContent).toContain("didn't upload");

    await userEvent.type(await box(), "look at this{Enter}");
    expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(false);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect((await box()).value).toBe("look at this");

    // Retry works (the next upload succeeds) and unblocks sending.
    await userEvent.click(within(chips).getByRole("button", { name: "Retry uploading big.pdf" }));
    await waitFor(() => expect(chips.querySelector("[data-status=ready]")).not.toBeNull());
    expect(screen.queryByTestId("attach-blocked")).toBeNull();
    await userEvent.type(await box(), "{Enter}");
    await waitFor(() => expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(true));
    expect(gateway.calls.find((c) => c.method === "chat.send")?.params).toHaveProperty(
      "attachments",
    );
  });

  it("is sendable again once the failed chip is removed", async () => {
    const { gateway } = mount();
    gateway.failNext("library.upload", "internal", "disk full");
    await attach(pdf("big.pdf"));
    const chips = await screen.findByTestId("attach-chips");
    await waitFor(() => expect(chips.querySelector("[data-status=error]")).not.toBeNull());
    await userEvent.click(within(chips).getByRole("button", { name: "Remove big.pdf" }));
    await userEvent.type(await box(), "no file{Enter}");
    await waitFor(() => expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(true));
  });
});

describe("Send keeps the focus in the composer", () => {
  it("refocuses the field after a click on Send", async () => {
    mount();
    const field = await box();
    await userEvent.type(field, "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(document.activeElement).toBe(field));
  });
});

describe("a queued follow-up sent now keeps its files", () => {
  const item = {
    id: "queued-1",
    threadId: B,
    content: "use this too",
    mode: "followUp" as const,
    replyToMessageId: null,
    attachments: ["lib-1"],
    attachedFiles: [{ path: "/Users/me/report.txt" }],
  };

  async function queued() {
    const m = mount();
    await go("go-b");
    await screen.findByRole("textbox", { name: "Message Wren" });
    await waitFor(() =>
      expect(m.gateway.calls.some((c) => c.method === "chat.history")).toBe(true),
    );
    act(() => m.store.update((s) => ({ ...s, queue: [...s.queue, item] })));
    return m;
  }

  it("sends the attachments with Steer now", async () => {
    const { gateway, store } = await queued();
    await userEvent.click(
      (await screen.findAllByRole("button", { name: /use this too/ }))[0] as HTMLElement,
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "Send now, to steer" }));
    await waitFor(() => expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(true));
    expect(gateway.calls.find((c) => c.method === "chat.send")?.params).toMatchObject({
      content: "use this too",
      mode: "steer",
      attachments: ["lib-1"],
      attachedFiles: [{ path: "/Users/me/report.txt" }],
    });
    expect(store.getState().queue.some((q) => q.id === "queued-1")).toBe(false);
  });

  it("puts the item back when the chat is busy", async () => {
    const { gateway, store } = await queued();
    gateway.failNext("chat.send", "conflict", "busy", { reason: "thread_busy" });
    await userEvent.click(
      (await screen.findAllByRole("button", { name: /use this too/ }))[0] as HTMLElement,
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "Send now, interrupting" }));
    await waitFor(() => expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(true));
    await waitFor(() =>
      expect(store.getState().queue.find((q) => q.id === "queued-1")?.attachments).toEqual([
        "lib-1",
      ]),
    );
  });
});
