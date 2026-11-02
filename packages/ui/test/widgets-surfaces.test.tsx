import type { Task, Widget } from "@psyche/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { morningBrief } from "../src/fixtures/daily.ts";
import { createFixtureWorld, IDS } from "../src/fixtures/index.ts";
import { FeedPostCard } from "../src/screens/feed/FeedPostCard.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";
import { boundWidget } from "../src/widgets/fixtures-bound.ts";
import { interactiveWidget } from "../src/widgets/fixtures-interactive.ts";
import { withFeedWidget } from "../src/widgets/fixtures-surfaces.ts";
import { PinnedWidgets } from "../src/widgets/PinnedWidgets.tsx";
import { WidgetBlockView, WidgetDrafts } from "../src/widgets/WidgetBlock.tsx";

function world(children: React.ReactNode, widgets: Widget[], slots?: Record<string, unknown>) {
  const methods: string[] = [];
  const ref: { gateway?: MockGateway } = {};
  render(
    <StoryWorld
      slots={slots as never}
      edit={(w) => {
        w.widgets = widgets;
      }}
      onGateway={(g) => {
        ref.gateway = g;
        const original = g.request.bind(g);
        g.request = ((method: string, params: unknown, options: unknown) => {
          methods.push(method);
          return (original as (...a: unknown[]) => unknown)(method, params, options);
        }) as typeof g.request;
      }}
    >
      {children}
    </StoryWorld>,
  );
  return { methods, ref };
}

describe("pin to Home (D5)", () => {
  it("pins from the widget frame, shows it pressed, and the Overview block lists it live", async () => {
    const w = boundWidget(IDS.tasks.dentist, IDS.threads.dentist);
    const { methods } = world(
      <>
        <WidgetBlockView block={{ type: "ui", widgetId: w.id }} />
        <PinnedWidgets />
      </>,
      [w],
    );
    const pin = await screen.findByTestId("widget-pin");
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("section-pinned")).toBeNull(); // nothing pinned: nothing shown
    await userEvent.setup().click(pin);
    await waitFor(() => expect(methods).toContain("widgets.pin"));
    await waitFor(() =>
      expect(screen.getAllByTestId("widget-pin")[0]?.getAttribute("aria-pressed")).toBe("true"),
    );
    const block = await screen.findByTestId("section-pinned");
    expect(within(block).getByRole("heading", { name: "Pinned" })).toBeTruthy();
    expect(within(block).getByTestId("widget")).toBeTruthy();
  });

  it("a pinned bound widget keeps following its task on the Overview", async () => {
    const w = { ...boundWidget(IDS.tasks.dentist, IDS.threads.dentist), pinned: true };
    const { ref } = world(<PinnedWidgets />, [w]);
    const block = await screen.findByTestId("section-pinned");
    await waitFor(() =>
      expect(within(block).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1"),
    );
    const task = ref.gateway?.world.tasks.find((t) => t.id === IDS.tasks.dentist) as Task;
    act(() =>
      ref.gateway?.emit("task.updated", {
        task: {
          ...task,
          checklist: task.checklist.map((c) => ({ ...c, status: "completed" as const })),
        },
      }),
    );
    await waitFor(() =>
      expect(within(block).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3"),
    );
  });

  it("refuses a 7th pin with a plain message, and unpinning removes it from the Overview", async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      ...boundWidget(IDS.tasks.dentist, IDS.threads.dentist),
      id: `wdg_p${i}`,
      pinned: i < 6,
    }));
    const { methods } = world(
      <>
        <WidgetBlockView block={{ type: "ui", widgetId: "wdg_p6" }} />
        <PinnedWidgets />
      </>,
      many,
    );
    const user = userEvent.setup();
    const pins = await screen.findAllByTestId("widget-pin");
    const seventh = pins.find((p) => p.getAttribute("aria-pressed") === "false") as HTMLElement;
    await user.click(seventh);
    expect(await screen.findByText(/up to 6 widgets/)).toBeTruthy();
    expect(methods.filter((m) => m === "widgets.pin")).toHaveLength(1);
    const block = await screen.findByTestId("section-pinned");
    expect(within(block).getAllByTestId("widget")).toHaveLength(6);
    const first = within(block).getAllByTestId("widget-pin")[0] as HTMLElement;
    await user.click(first);
    await waitFor(() =>
      expect(within(screen.getByTestId("section-pinned")).getAllByTestId("widget")).toHaveLength(5),
    );
  });
});

describe("Overview and Feed draw open and reply only (§8)", () => {
  it("a pinned interactive widget has no choices, forms, tool or answer controls; reply fills the composer", async () => {
    const prefill = vi.fn();
    const w = { ...interactiveWidget, pinned: true, taint: [] };
    const { methods } = world(<PinnedWidgets />, [w], { prefillComposer: prefill });
    const block = await screen.findByTestId("section-pinned");
    await within(block).findByRole("button", { name: "Draft the replies now" });
    expect(within(block).queryByRole("form")).toBeNull();
    expect(within(block).queryByRole("radio")).toBeNull();
    expect(within(block).queryByRole("button", { name: "Send the draft" })).toBeNull(); // tool
    await userEvent
      .setup()
      .click(within(block).getByRole("button", { name: "Draft the replies now" }));
    await waitFor(() => expect(prefill).toHaveBeenCalledWith("Draft the replies now"));
    // The owner sends it themselves: nothing went to chat.send, no tool was proposed.
    expect(methods).not.toContain("chat.send");
    expect(methods).not.toContain("widgets.act");
    expect(methods).not.toContain("widgets.preview");
  });

  it("a Feed post's widget is a static snapshot: no bindings, no remote image, no tool/answer/choices", async () => {
    const prefill = vi.fn();
    const navigate = vi.fn();
    const base = createFixtureWorld().feed.find((f) => f.id === IDS.feed.briefing) as never;
    const { methods } = world(
      <FeedPostCard post={withFeedWidget(base)} onFeedback={() => {}} onAsk={() => {}} />,
      [],
      { prefillComposer: prefill, navigate },
    );
    const frame = await screen.findByTestId("widget");
    expect(within(frame).getByTestId("widget-state").textContent).toBe("Snapshot");
    // The taint travels with the snapshot.
    expect(within(frame).getByTestId("widget-untrusted")).toBeTruthy();
    // Static: the bound progress shows its own numbers and never asks the Gateway for a task.
    expect(within(frame).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
    expect(methods).not.toContain("tasks.get");
    expect(within(frame).queryByRole("button", { name: "Book now" })).toBeNull();
    expect(within(frame).queryByRole("button", { name: "Tuesday" })).toBeNull();
    expect(within(frame).queryByRole("radio")).toBeNull();
    expect(within(frame).queryByTestId("widget-pin")).toBeNull();
    expect(within(frame).queryByRole("img", { name: "Hotel photo" })).toBeNull();
    await userEvent
      .setup()
      .click(within(frame).getByRole("button", { name: "Ask about the rest" }));
    await waitFor(() => expect(prefill).toHaveBeenCalledWith("What is still open on the trip?"));
    await userEvent.setup().click(within(frame).getByRole("button", { name: "Open calendar" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/scheduled"));
    expect(methods.filter((m) => m.startsWith("widgets."))).toEqual([]);
    expect(methods).not.toContain("chat.send");
  });

  it("a card post (the daily brief) shows its snapshot beside the card", async () => {
    const base = createFixtureWorld().feed.find((f) => f.id === IDS.feed.briefing) as never;
    const post = {
      ...withFeedWidget(base),
      card: { type: "daily", daily: morningBrief() },
    } as never;
    world(<FeedPostCard post={post} onFeedback={() => {}} onAsk={() => {}} />, []);
    const frame = await screen.findByTestId("widget");
    expect(within(frame).getByTestId("widget-state").textContent).toBe("Snapshot");
  });

  it("a widget draft shows the nodes so far, read-only, and goes when the call ends", async () => {
    const { ref } = world(<WidgetDrafts threadId="thr_1" />, []);
    expect(screen.queryByTestId("widget-draft")).toBeNull();
    act(() => {
      ref.gateway?.emit("widget.draft", {
        threadId: "thr_1",
        messageId: "m1",
        callId: "call_1",
        title: "Trip plan",
        nodes: 2,
        root: {
          id: "root",
          type: "stack",
          children: [{ id: "a", type: "text", text: "Pack the bags" }],
        },
      } as never);
    });
    const draft = await screen.findByTestId("widget-draft");
    expect(draft.getAttribute("aria-busy")).toBe("true");
    expect(within(draft).getByText("Pack the bags")).toBeTruthy();
    expect(within(draft).getByText("Trip plan")).toBeTruthy();
    expect(within(draft).getByTestId("widget-state").textContent).toBe("Building widget…");
    expect(within(draft).queryByRole("button")).toBeNull(); // no pin, no copy, no controls
    // Another thread's draft is not shown here.
    act(() => {
      ref.gateway?.emit("widget.draft", {
        threadId: "thr_2",
        messageId: "m2",
        callId: "call_2",
        nodes: 0,
      } as never);
    });
    expect(screen.getAllByTestId("widget-draft")).toHaveLength(1);
    act(() => {
      ref.gateway?.emit("widget.draft", {
        threadId: "thr_1",
        messageId: "m1",
        callId: "call_1",
        nodes: 0,
        done: true,
      } as never);
    });
    await waitFor(() => expect(screen.queryByTestId("widget-draft")).toBeNull());
  });
});
