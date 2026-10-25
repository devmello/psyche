import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatThread } from "../src/chat/Thread.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { activeI18n, setActiveI18n } from "../src/i18n/core.ts";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";

const NOW = Date.parse(FIXTURE_NOW);
const initial = activeI18n();
afterEach(() => setActiveI18n(initial));

const Dir = ({ children }: { children: ReactNode }) => (
  <div dir={activeI18n().dir} data-testid="dir">
    {children}
  </div>
);

function renderRtlThread() {
  const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  return render(
    <I18nProvider direction="rtl">
      <Dir>
        <GatewayProvider client={gateway} store={store}>
          <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
            {/* Level 0: tool runs folded, so their chevrons point along the reading direction. */}
            <ChatThread threadId={IDS.threads.dentist} now={NOW} disclosure={0} />
          </UiSlotsProvider>
        </GatewayProvider>
      </Dir>
    </I18nProvider>,
  );
}

describe("the chat column right to left", () => {
  it("uses logical directions and mirrors chevrons and the reply icon", async () => {
    renderRtlThread();
    expect(screen.getByTestId("dir").getAttribute("dir")).toBe("rtl");
    const log = await screen.findByRole("log", { name: "Conversation" });
    await waitFor(() => expect(within(log).getAllByRole("article").length).toBeGreaterThan(3));

    // User bubbles sit at the inline end (flex alignment flips with dir); agent text is inset
    // from the inline start, with the actions menu pushed to the inline end.
    const user = log.querySelector<HTMLElement>('[data-role="user"]');
    expect(user?.className).toContain("items-end");
    const agent = log.querySelector<HTMLElement>('[data-role="agent"]');
    expect(agent?.querySelector(".ps-7")).not.toBeNull();
    expect(agent?.querySelector(".ms-auto")).not.toBeNull();
    expect(log.querySelector(".pl-7, .ml-auto, .text-left, .border-l-2")).toBeNull();

    // A folded tool run's chevron points the other way under RTL.
    const run = log.querySelector("[data-disclosure] svg.lucide-chevron-right");
    expect(run?.getAttribute("class")).toContain("rtl:rotate-180");

    // The approval card's leading edge sits at the inline start (logical inset, not left).
    const edge = (await screen.findAllByTestId("approval-edge"))[0];
    expect(edge?.getAttribute("class")).toContain("start-0");

    // Reply arrows flip horizontally.
    const [actions] = within(log).getAllByRole("button", { name: "Message actions" });
    await userEvent.click(actions as HTMLElement);
    const reply = await screen.findByRole("menuitem", { name: "Reply" });
    expect(reply.querySelector("svg")?.getAttribute("class")).toContain("rtl:-scale-x-100");
  });

  it("still renders the extracted English strings", async () => {
    renderRtlThread();
    expect(await screen.findByRole("textbox", { name: "Message Wren" })).toBeTruthy();
    expect(await screen.findAllByText("Approval needed")).not.toHaveLength(0);
    expect(screen.getAllByText("Requested by").length).toBeGreaterThan(0);
    // One Send/Stop button: this thread's run is working and the field is empty, so it is Stop.
    expect(screen.getByRole("button", { name: "Stop the run (Esc)" })).toBeTruthy();
  });
});
