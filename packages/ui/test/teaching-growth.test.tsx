import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { agentSheetRoute } from "../src/agent/AgentSheet.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import {
  createFixtureWorld,
  FIXTURE_NOW,
  type FixtureWorld,
  growthFeedPost,
  LEARNING_IDS,
} from "../src/fixtures/index.ts";
import { FeedPostCard } from "../src/screens/feed/FeedPostCard.tsx";
import { DataControlsSection } from "../src/screens/settings/DataControlsSection.tsx";
import { type UiSlots, UiSlotsProvider } from "../src/slots.tsx";
import { GrowthPanel } from "../src/teaching/GrowthPanel.tsx";

const L = LEARNING_IDS.lessons;

function setup(
  ui: ReactElement,
  { edit, slots = {} }: { edit?: (w: FixtureWorld) => void; slots?: UiSlots } = {},
) {
  const world = createFixtureWorld();
  edit?.(world);
  const gateway = new MockGateway(world, { now: () => FIXTURE_NOW });
  const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
  const utils = render(
    <GatewayProvider client={gateway} store={store}>
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" }, ...slots }}>
        {ui}
      </UiSlotsProvider>
    </GatewayProvider>,
  );
  return { gateway, ...utils };
}

const callsOf = (gateway: MockGateway, method: string) =>
  gateway.calls.filter((c) => c.method === method);

describe("Growth (teaching loop §5.3)", () => {
  it("shows lessons and milestones with provenance, newest first, and what got better", async () => {
    setup(<GrowthPanel />);
    const growth = await screen.findByTestId("growth");
    const rows = within(growth).getAllByTestId("growth-lesson");
    expect(rows[0]?.textContent).toContain("Replies to Jane are short");
    expect(rows[0]?.textContent).toContain("You told me");
    expect(rows[0]?.textContent).toContain("USER.md");
    expect(within(growth).getByText("The morning brief runs at 7:30 on weekdays.")).toBeTruthy();
    expect(within(growth).getByText("You confirmed")).toBeTruthy();
    expect(within(growth).getByText("inbox-triage skill")).toBeTruthy();
    // Superseded and forgotten lessons are not growth.
    expect(within(growth).queryByText("Explain the reasoning, then the answer.")).toBeNull();
    expect(within(growth).queryByText("Use emoji in replies.")).toBeNull();
    expect(within(growth).getByText("First automation: Morning brief")).toBeTruthy();
    const metrics = within(growth).getAllByTestId("growth-metric");
    expect(metrics[0]?.textContent).toContain("Drafts sent as-is");
    expect(metrics[0]?.textContent).toContain("1 of 4");
  });

  it("Show change opens the diff, and the period reloads the summary", async () => {
    const { gateway } = setup(<GrowthPanel />);
    const growth = await screen.findByTestId("growth");
    const [first] = within(growth).getAllByRole("button", { name: "Show change" });
    if (first === undefined) throw new Error("no Show change");
    await userEvent.click(first);
    expect(within(growth).getByText(/open with "Hi Jane"/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() =>
      expect(
        callsOf(gateway, "growth.summary").some(
          (c) => (c.params as { window: string }).window === "7d",
        ),
      ).toBe(true),
    );
  });

  it("filters to what it noticed", async () => {
    setup(<GrowthPanel />);
    const growth = await screen.findByTestId("growth");
    await userEvent.click(within(growth).getByRole("button", { name: "Noticed" }));
    expect(within(growth).queryAllByTestId("growth-lesson")).toHaveLength(0);
    expect(within(growth).getAllByTestId("growth-milestone").length).toBeGreaterThan(0);
  });

  it("says so when nothing is learned yet", async () => {
    setup(<GrowthPanel />, {
      edit: (w) => {
        w.lessons = [];
        w.milestones = [];
      },
    });
    expect(
      await screen.findByText(
        "Nothing learned yet. Tell Wren when something isn't right and it will remember.",
      ),
    ).toBeTruthy();
  });

  it("shows the error with Try again", async () => {
    const world = createFixtureWorld();
    const gateway = new MockGateway(world, { now: () => FIXTURE_NOW });
    gateway.failNext("growth.summary", "unavailable", "offline");
    const store = new GatewayStore(gateway, { now: () => FIXTURE_NOW });
    render(
      <GatewayProvider client={gateway} store={store}>
        <GrowthPanel />
      </GatewayProvider>,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("growth")).toBeTruthy();
  });

  it("is a route of the agent sheet", () => {
    expect(agentSheetRoute("/agent/growth")).toEqual({ tab: "growth" });
  });
});

describe("The weekly card (teaching loop §5.4)", () => {
  it("Keep confirms a lesson, Yes remembers a question, and Open Growth navigates", async () => {
    const navigate = vi.fn();
    const { gateway } = setup(<FeedPostCard post={growthFeedPost()} />, { slots: { navigate } });
    const items = screen.getAllByTestId("growth-card-item");
    expect(items).toHaveLength(4);
    const lesson = items[0] as HTMLElement;
    await userEvent.click(within(lesson).getByRole("button", { name: "Keep" }));
    expect(await within(lesson).findByText("Kept.")).toBeTruthy();
    expect(gateway.world.lessons.find((l) => l.id === L.janeShort)?.status).toBe("confirmed");
    const question = items[2] as HTMLElement;
    await userEvent.click(within(question).getByRole("button", { name: "Yes, remember" }));
    expect(await within(question).findByText("Wren will remember it.")).toBeTruthy();
    expect(callsOf(gateway, "feedback.give")[0]?.params).toMatchObject({
      target: { type: "feed_post", id: LEARNING_IDS.growthPost },
      kind: "correction",
    });
    const retire = items[3] as HTMLElement;
    await userEvent.click(within(retire).getByRole("button", { name: "Forget" }));
    expect(await within(retire).findByText("Forgotten.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open Growth" }));
    expect(navigate).toHaveBeenCalledWith("/overview#growth");
  });
});

describe("Settings → Learning (teaching loop §8)", () => {
  it("pauses learning and forgets everything after typing the word", async () => {
    const navigate = vi.fn();
    const { gateway } = setup(<DataControlsSection />, { slots: { navigate } });
    await userEvent.click(await screen.findByRole("switch", { name: "Pause learning" }));
    await waitFor(() => expect(gateway.world.settings["teaching.paused"]).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Open Growth" }));
    expect(navigate).toHaveBeenCalledWith("/overview#growth");
    await userEvent.click(screen.getByRole("button", { name: "Forget everything Wren learned" }));
    const go = screen.getByRole("button", { name: "Forget everything" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByRole("textbox", { name: /Type "forget"/ }), "forget");
    await userEvent.click(go);
    expect(await screen.findByText(/Forgot 5 lessons and 8 feedback events/)).toBeTruthy();
    expect(gateway.world.lessons.every((l) => l.status === "forgotten")).toBe(true);
  });
});
