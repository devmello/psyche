import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { ChatThread } from "../src/chat/Thread.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW, IDS } from "../src/fixtures/index.ts";
import { OnboardingFlow } from "../src/screens/onboarding/OnboardingFlow.tsx";
import { SettingsScreen } from "../src/screens/settings/SettingsScreen.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

/** Keyboard-only paths (docs/a11y-audit.md, "Gates"): no pointer anywhere in these tests. */

const NOW = Date.parse(FIXTURE_NOW);

/** A control's name the way the accessibility tree builds it, enough for these checks. */
function nameOf(el: Element): string {
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    return by
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  }
  const label = el.getAttribute("aria-label");
  if (label) return label.trim();
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length > 0)
    return [...labels]
      .map((l) => l.textContent ?? "")
      .join(" ")
      .trim();
  return (el.textContent ?? el.getAttribute("title") ?? "").trim();
}

describe("chat column by keyboard", () => {
  it("Shift+Return adds a line and Return sends (or queues while a run is going)", async () => {
    const gateway = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
    const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
    render(
      <GatewayProvider client={gateway} store={store}>
        <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
          <ChatThread threadId={IDS.threads.dentist} now={NOW} />
        </UiSlotsProvider>
      </GatewayProvider>,
    );
    const box = (await screen.findByRole("textbox", {
      name: "Message Wren",
    })) as HTMLTextAreaElement;
    box.focus();
    await userEvent.keyboard("first line{Shift>}{Enter}{/Shift}second line");
    expect(box.value).toBe("first line\nsecond line");
    expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(false);
    await userEvent.keyboard("{Enter}");
    // The fixture thread may have a run going: then Return queues the follow-up instead.
    const busy = gateway.world.runs.some(
      (r) => r.threadId === IDS.threads.dentist && r.status === "running",
    );
    if (busy) expect(await screen.findByText(/Queued/)).toBeTruthy();
    else
      await waitFor(() => expect(gateway.calls.some((c) => c.method === "chat.send")).toBe(true));
    expect(box.value).toBe("");
  });
});

describe("approval card by keyboard", () => {
  it("arrow keys change the scope and ⌘Return allows the chosen one", async () => {
    const approval = createFixtureWorld().approvals.find((a) => a.status === "pending");
    if (!approval) throw new Error("no pending approval");
    const onAnswer = vi.fn();
    render(
      <ApprovalCard approval={approval} canAnswer now={NOW} armDelayMs={0} onAnswer={onAnswer} />,
    );
    const group = screen.getByRole("radiogroup", { name: "Decision" });
    const radios = within(group).getAllByRole("radio");
    const checked = () => radios.find((r) => r.getAttribute("aria-checked") === "true");
    // Deny is preselected (§3.3); move to the first allowing scope with the arrow keys.
    (checked() ?? radios[0])?.focus();
    const before = checked();
    await userEvent.keyboard("{ArrowLeft}");
    const after = checked();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(onAnswer).toHaveBeenCalled());
    expect(onAnswer.mock.calls[0]?.[0]).toBe("approve");
  });
});

describe("Settings by keyboard", () => {
  it("every Tab stop has a name, and Space flips a switch", async () => {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld onGateway={(g) => (gw = g)}>
        <SettingsScreen now={NOW} defaultSection="appearance" />
      </StoryWorld>,
    );
    await screen.findByRole("heading", { level: 2, name: "Appearance" });
    const seen = new Set<Element>();
    for (let i = 0; i < 40; i++) {
      await userEvent.tab();
      const el = document.activeElement;
      if (!el || el === document.body || seen.has(el)) break;
      seen.add(el);
      expect(nameOf(el), `${el.tagName} at stop ${i}`).not.toBe("");
    }
    expect(seen.size).toBeGreaterThan(8);
    const contrast = screen.getByRole("switch", { name: /High contrast/ });
    contrast.focus();
    await userEvent.keyboard(" ");
    await waitFor(() =>
      expect(
        (gw as unknown as MockGateway).calls.some(
          (c) =>
            c.method === "settings.set" &&
            (c.params as { key: string }).key === "appearance.contrast",
        ),
      ).toBe(true),
    );
  });
});

describe("onboarding by keyboard", () => {
  it("goes forward and back, landing on each step's heading", async () => {
    render(
      <StoryWorld>
        <OnboardingFlow onComplete={() => {}} />
      </StoryWorld>,
    );
    const heading = () => screen.getByRole("heading", { level: 1 });
    const first = heading().textContent;
    screen.getByRole("button", { name: "Next" }).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(heading().textContent).not.toBe(first));
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    screen.getByRole("button", { name: "Back" }).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(heading().textContent).toBe(first));
    expect(document.activeElement).toBe(heading());
  });
});
