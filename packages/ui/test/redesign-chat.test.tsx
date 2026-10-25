import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentHeader } from "../src/agent/AgentHeader.tsx";
import { ChatThread } from "../src/chat/Thread.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { addLongConversation } from "../src/fixtures/long-thread.ts";
import { UiSlotsProvider } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

const NOW = Date.parse(FIXTURE_NOW);

function renderMain(edit?: (w: ReturnType<typeof createFixtureWorld>) => void) {
  const world = createFixtureWorld();
  edit?.(world);
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
  return { gateway, world };
}

/** jsdom has no layout: give the viewport a scroll geometry the test controls. */
function fakeScroll(el: HTMLElement, initialHeight: number) {
  const box = { height: initialHeight, top: 0 };
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.height });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 500 });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => box.top,
    set: (v: number) => {
      box.top = Math.max(0, Math.min(v, box.height - 500));
    },
  });
  el.scrollTo = ((opts: ScrollToOptions) => {
    el.scrollTop = opts.top ?? 0;
  }) as typeof el.scrollTo;
  return box;
}

describe("transcript (redesign-2026 §5.2, motion.md §4.6)", () => {
  it("stays anchored to the bottom while the reader is there, and offers a jump pill otherwise", async () => {
    const { gateway } = renderMain((w) => addLongConversation(w, IDS.threads.main, 50));
    const log = await screen.findByRole("log", { name: "Conversation" });
    await waitFor(() =>
      expect(within(log).getAllByRole("article").length).toBeGreaterThanOrEqual(50),
    );
    const box = fakeScroll(log, 5000);
    log.scrollTop = 4500;
    fireEvent.scroll(log);

    // New content while at the end: the end stays in view, instantly.
    box.height = 5300;
    act(() =>
      gateway.emit("chat.delta", {
        threadId: IDS.threads.main,
        messageId: "msg_stream_1",
        delta: "Looking",
      }),
    );
    await waitFor(() => expect(log.scrollTop).toBe(4800));
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();

    // The reader scrolls up: new content no longer moves them, and the pill appears.
    log.scrollTop = 1000;
    fireEvent.scroll(log);
    box.height = 5600;
    act(() =>
      gateway.emit("chat.delta", {
        threadId: IDS.threads.main,
        messageId: "msg_stream_1",
        delta: " at your calendar",
      }),
    );
    const pill = await screen.findByTestId("jump-to-latest");
    expect(log.scrollTop).toBe(1000);
    await userEvent.click(pill);
    expect(log.scrollTop).toBe(5100);
    await waitFor(() => expect(screen.queryByTestId("jump-to-latest")).toBeNull());
  });

  it("never animates streamed text", async () => {
    const { gateway } = renderMain();
    const log = await screen.findByRole("log", { name: "Conversation" });
    act(() =>
      gateway.emit("chat.delta", {
        threadId: IDS.threads.main,
        messageId: "msg_stream_2",
        delta: "Streaming words arrive as they are",
      }),
    );
    const text = await within(log).findByText(/Streaming words arrive/);
    act(() =>
      gateway.emit("chat.delta", {
        threadId: IDS.threads.main,
        messageId: "msg_stream_2",
        delta: " written",
      }),
    );
    await within(log).findByText(/as they are written/);
    // No ancestor up to the message carries an animated opacity or transform.
    const article = text.closest("article");
    expect(article).not.toBeNull();
    for (
      let el: HTMLElement | null = text;
      el && el !== article?.parentElement;
      el = el.parentElement
    ) {
      expect(el.style.opacity, el.tagName).toBe("");
      expect(el.style.transform, el.tagName).toBe("");
    }
  });

  it("shows the time on hover instead of under each message", async () => {
    renderMain();
    const log = await screen.findByRole("log", { name: "Conversation" });
    await waitFor(() => expect(within(log).getAllByRole("article").length).toBeGreaterThan(0));
    const times = within(log).getAllByTestId("message-time");
    expect(times.length).toBeGreaterThan(0);
    for (const time of times) {
      expect(time.className).toMatch(/\bopacity-0\b/);
      expect(time.className).toMatch(/group-hover\/message:opacity-100/);
      expect(time.getAttribute("aria-hidden")).toBe("true");
    }
    // The article's label still carries the time for assistive tech.
    expect(within(log).getAllByRole("article")[0]?.getAttribute("aria-label")).toMatch(/\d/);
  });

  it("floats the composer as a capsule outside the scrolling log, with one Send/Stop button", async () => {
    renderMain();
    const log = await screen.findByRole("log", { name: "Conversation" });
    const capsule = screen.getByTestId("composer-capsule");
    expect(log.contains(capsule)).toBe(false);
    expect(capsule.className).toMatch(/material-glass/);
    const box = within(capsule).getByRole("textbox", { name: "Message Wren" });
    const send = within(capsule).getByRole("button", { name: "Send" });
    expect(send.hasAttribute("disabled")).toBe(true);
    await userEvent.type(box, "hi");
    expect(within(capsule).getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(
      false,
    );
  });
});

describe("toolbar (redesign-2026 §4, §5.2)", () => {
  it("is a labelled toolbar with a 28 px avatar, the pill group and the view level in ⋯", async () => {
    const onDisclosureChange = vi.fn();
    const onExport = vi.fn();
    render(
      <StoryWorld>
        <AgentHeader
          onOpenSheet={() => {}}
          mode="balanced"
          onModeChange={() => {}}
          model="anthropic/claude-sonnet-5-5"
          onOpenModelPicker={() => {}}
          disclosure={1}
          onDisclosureChange={onDisclosureChange}
          onExport={onExport}
        />
      </StoryWorld>,
    );
    const toolbar = screen.getByRole("toolbar", { name: "Chat toolbar" });
    const pills = within(toolbar).getByTestId("toolbar-pills");
    expect(within(pills).getByRole("button", { name: /Permission mode/ })).toBeTruthy();
    expect(within(pills).getByRole("button", { name: /Model: Sonnet 5.5/ })).toBeTruthy();
    await userEvent.click(within(toolbar).getByRole("button", { name: "More" }));
    const raw = await screen.findByRole("menuitemradio", { name: /Raw tool I\/O/ });
    expect(
      screen.getByRole("menuitemradio", { name: /Actions/ }).getAttribute("aria-checked"),
    ).toBe("true");
    await userEvent.click(raw);
    expect(onDisclosureChange).toHaveBeenCalledWith(2);
  });
});

describe("approval dock (redesign-2026 §5.3, docs/06 §3.3)", () => {
  it("keeps the fixed structure: Deny preselected, scope as one segmented control, armed after 400 ms", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <StoryWorld>
          <div style={{ height: 900 }}>
            <ChatThread threadId={IDS.threads.dentist} now={NOW} />
          </div>
        </StoryWorld>,
      );
      const dock = await screen.findByTestId("approval-dock");
      const group = await within(dock).findByRole("radiogroup", { name: "Decision" });
      const radios = within(group).getAllByRole("radio");
      expect(radios.at(-1)?.getAttribute("aria-label")).toBe("Deny");
      expect(radios.at(-1)?.getAttribute("aria-checked")).toBe("true");
      const deny = within(dock).getByRole("button", { name: "Deny" });
      const allow = within(dock).getByRole("button", { name: "Allow with scope" });
      // Deny leads, Allow trails.
      expect(deny.compareDocumentPosition(allow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(deny.hasAttribute("disabled")).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(450);
      });
      await waitFor(() => expect(deny.hasAttribute("disabled")).toBe(false));
      // Allow stays off while Deny is the choice; picking a scope arms it.
      expect(allow.hasAttribute("disabled")).toBe(true);
      fireEvent.click(radios[0] as HTMLElement);
      await waitFor(() => expect(allow.hasAttribute("disabled")).toBe(false));
    } finally {
      vi.useRealTimers();
    }
  });

  it("stacks several approvals as a deck and brings the next one forward", async () => {
    render(
      <StoryWorld>
        <div style={{ height: 900 }}>
          <ChatThread threadId={IDS.threads.dentist} now={NOW} />
        </div>
      </StoryWorld>,
    );
    const dock = await screen.findByTestId("approval-dock");
    const card = () => dock.querySelector<HTMLElement>("[data-approval-id]");
    await waitFor(() => expect(card()).not.toBeNull());
    const first = card()?.dataset.approvalId;
    const more = within(dock).getByRole("button", { name: /^1 more · next: / });
    expect(dock.querySelectorAll("[data-testid=approval-deck] > span[aria-hidden]")).toHaveLength(
      1,
    );
    await userEvent.click(more);
    await waitFor(() => expect(card()?.dataset.approvalId).not.toBe(first));
  });

  it("turns an answered approval into its one-line result row in the transcript", async () => {
    const ref: { gateway?: MockGateway } = {};
    render(
      <StoryWorld onGateway={(g) => (ref.gateway = g)}>
        <div style={{ height: 900 }}>
          <ChatThread threadId={IDS.threads.dentist} now={NOW} />
        </div>
      </StoryWorld>,
    );
    const log = await screen.findByRole("log", { name: "Conversation" });
    await waitFor(() =>
      expect(within(log).getAllByRole("button", { name: /^Review approval:/ }).length).toBe(2),
    );
    const pending = ref.gateway?.world.approvals.find(
      (a) => a.id === IDS.approvals.sendEmail && a.status === "pending",
    );
    if (pending === undefined || ref.gateway === undefined) throw new Error("fixture missing");
    const gateway = ref.gateway;
    act(() =>
      gateway.emit("approval.updated", {
        approval: { ...pending, status: "approved", decidedAt: FIXTURE_NOW, scopeGranted: "once" },
      }),
    );
    const row = await within(log).findByTestId("approval-result");
    expect(row.textContent).toMatch(/Send an email/);
    await waitFor(() =>
      expect(within(log).getAllByRole("button", { name: /^Review approval:/ })).toHaveLength(1),
    );
  });
});
