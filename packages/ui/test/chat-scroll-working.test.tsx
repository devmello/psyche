import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ChatThread } from "../src/chat/Thread.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { addLongConversation } from "../src/fixtures/long-thread.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

const NOW = Date.parse(FIXTURE_NOW);

function renderMain(edit?: (w: ReturnType<typeof createFixtureWorld>) => void) {
  const world = createFixtureWorld();
  edit?.(world);
  const gateway = new MockGateway(world, { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  render(
    <GatewayProvider client={gateway} store={store}>
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
        <div className="flex h-[600px] flex-col" data-testid="host">
          <ChatThread threadId={IDS.threads.main} now={NOW} />
        </div>
      </UiSlotsProvider>
    </GatewayProvider>,
  );
  return { gateway, world };
}

describe("chat column scrolling (#548)", () => {
  it("scrolls fifty messages inside the viewport, never the page", async () => {
    renderMain((w) => addLongConversation(w, IDS.threads.main, 50));
    const log = await screen.findByRole("log", { name: "Conversation" });
    await waitFor(() =>
      expect(within(log).getAllByRole("article").length).toBeGreaterThanOrEqual(50),
    );
    // The viewport is the scroll container, and it may shrink below its content.
    expect(log.className).toMatch(/\boverflow-y-auto\b/);
    expect(log.className).toMatch(/\bmin-h-0\b/);
    // Every box between the viewport and the host flex column can shrink and none scrolls,
    // so the transcript's height never reaches the window.
    const host = screen.getByTestId("host");
    for (let el = log.parentElement; el !== null && el !== host; el = el.parentElement) {
      expect(el.className, el.outerHTML.slice(0, 80)).toMatch(/\bmin-h-0\b/);
      expect(el.className).toMatch(/\boverflow-hidden\b/);
    }
    // The composer is outside the scrolling box, pinned below it.
    const composer = screen.getByRole("textbox", { name: "Message Wren" });
    expect(log.contains(composer)).toBe(false);
    expect(document.body.scrollTop).toBe(0);
  });
});

describe("working indicator (#548)", () => {
  it("says Wren is working from send until the run settles, and names the running tool", async () => {
    const { gateway, world } = renderMain();
    const box = await screen.findByRole("textbox", { name: "Message Wren" });
    await waitFor(() => expect(gateway.calls.some((c) => c.method === "chat.history")).toBe(true));
    expect(screen.queryByTestId("chat-working")).toBeNull();

    await userEvent.type(box, "Find my last receipt{Enter}");
    expect((await screen.findByTestId("chat-working")).textContent).toBe("Wren is working…");
    expect(screen.getByTestId("chat-working").getAttribute("role")).toBe("status");

    const base = world.runs[0];
    const call0 = world.toolCalls[0];
    if (base === undefined || call0 === undefined) throw new Error("fixture runs missing");
    const run = {
      ...base,
      id: "run_548",
      threadId: IDS.threads.main,
      status: "running" as const,
      endedAt: null,
      error: null,
    };
    act(() => gateway.setRun(run));
    act(() =>
      gateway.emit("tool_call.updated", {
        toolCall: {
          ...call0,
          id: "tc_548",
          runId: run.id,
          tool: "mail_search",
          status: "running",
          startedAt: FIXTURE_NOW,
          endedAt: null,
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-working").textContent).toBe("Running mail_search…"),
    );

    act(() => gateway.setRun({ ...run, status: "done", endedAt: FIXTURE_NOW }));
    await waitFor(() => expect(screen.queryByTestId("chat-working")).toBeNull());
  });
});
