import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyInsights,
  type FixtureWorld,
  growthFeedPost,
  insightsFixtures,
} from "../src/fixtures/index.ts";
import { GrowthAndPeople } from "../src/overview/GrowthAndPeople.tsx";
import type { OverviewPeriod } from "../src/overview/period.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

function typical(world: FixtureWorld, graph = true): void {
  Object.assign(world, { insights: insightsFixtures("typical") });
  world.graph.status = {
    ...world.graph.status,
    enabled: graph,
    counts: { people: 14, orgs: 2, projects: 6, places: 0, openLoops: 5, pendingSuggestions: 0 },
  };
  world.feed = [growthFeedPost(), ...world.feed];
}

function renderBoth(opts: {
  edit?: (w: FixtureWorld) => void;
  period?: OverviewPeriod;
  compact?: boolean;
  navigate?: (route: string) => void;
}) {
  return render(
    <StoryWorld
      edit={opts.edit ?? typical}
      {...(opts.navigate ? { slots: { navigate: opts.navigate } } : {})}
    >
      <div data-testid="overview">
        <GrowthAndPeople
          period={opts.period ?? "30d"}
          now={STORY_NOW}
          {...(opts.compact === undefined ? {} : { compact: opts.compact })}
        />
      </div>
    </StoryWorld>,
  );
}

describe("Growth", () => {
  it("shows the lesson counts, metrics with evidence, milestones and the weekly card row", async () => {
    renderBoth({});
    const growth = await screen.findByTestId("overview-growth");
    expect(within(growth).getByTestId("growth-count-learned").textContent).toMatch(/lesson/);
    expect(within(growth).getAllByTestId("growth-metric").length).toBeGreaterThan(0);
    expect(within(growth).getAllByTestId("growth-milestone").length).toBeGreaterThan(0);
    expect(await within(growth).findByTestId("growth-weekly-card")).toBeTruthy();
  });

  it("opens a metric's evidence ids in a popover", async () => {
    renderBoth({});
    const trigger = (await screen.findAllByTestId("growth-evidence"))[0] as HTMLElement;
    fireEvent.click(trigger);
    expect(await screen.findByText(/Events behind/)).toBeTruthy();
  });

  it('opens the week-grouped timeline behind "See all lessons"', async () => {
    renderBoth({});
    await screen.findByTestId("overview-growth");
    fireEvent.click(screen.getByRole("button", { name: "See all lessons" }));
    const sheet = await screen.findByTestId("growth-lessons");
    expect(within(sheet).getAllByTestId("growth-lesson").length).toBeGreaterThan(0);
    expect(within(sheet).getAllByText(/Week of/).length).toBeGreaterThan(0);
  });

  it("opens the weekly card's items in a sheet", async () => {
    renderBoth({});
    const row = await screen.findByTestId("growth-weekly-card");
    fireEvent.click(within(row).getByRole("button", { name: "Review" }));
    const sheet = await screen.findByTestId("growth-card-sheet");
    expect(within(sheet).getAllByTestId("growth-card-item").length).toBeGreaterThan(0);
  });

  it("says so when nothing was learned", async () => {
    renderBoth({
      edit: (w) => {
        typical(w);
        w.lessons = [];
        w.milestones = [];
        w.feedbackEvents = [];
      },
    });
    expect(await screen.findByText("Nothing learned in this period yet.")).toBeTruthy();
  });
});

describe("People & projects", () => {
  it("draws the top entities as nodes in rank order with the counts and ranked lines", async () => {
    renderBoth({});
    const nodes = await screen.findAllByTestId("people-node");
    const top = insightsFixtures("typical")["30d"].topEntities;
    expect(nodes).toHaveLength(top.length);
    expect(nodes.map((n) => n.getAttribute("data-rank"))).toEqual(nodes.map((_, i) => String(i)));
    expect(screen.getByTestId("people-counts").textContent).toBe(
      "14 people · 6 projects · 5 open loops",
    );
    expect(screen.getByTestId("people-ranked").textContent).toContain(`${top[0]?.name} `);
    // Exactly one tab stop, and edges only run from "you" (no entity-entity lines).
    expect(nodes.filter((n) => n.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(document.querySelectorAll("line")).toHaveLength(nodes.length);
  });

  it("names a node with its kind, interactions, recency and open loops", async () => {
    renderBoth({});
    const first = (await screen.findAllByTestId("people-node"))[0] as HTMLElement;
    expect(first.getAttribute("aria-label")).toMatch(/interaction/);
    expect(first.getAttribute("aria-label")).toMatch(/open loop/);
  });

  it("moves between nodes with the arrow keys and shows the focused node's detail", async () => {
    renderBoth({});
    const nodes = await screen.findAllByTestId("people-node");
    act(() => (nodes[0] as HTMLElement).focus());
    expect(screen.getByTestId("people-map-detail").textContent).toContain(
      insightsFixtures("typical")["30d"].topEntities[0]?.name,
    );
    fireEvent.keyDown(nodes[0] as HTMLElement, { key: "ArrowRight" });
    expect(document.activeElement).toBe(nodes[1]);
    expect((nodes[1] as HTMLElement).getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(nodes[1] as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(nodes.at(-1));
    fireEvent.keyDown(nodes.at(-1) as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(nodes[0]);
  });

  it("opens the entity in Soul & Memory on click and Enter", async () => {
    const navigate = vi.fn();
    renderBoth({ navigate });
    const nodes = await screen.findAllByTestId("people-node");
    const top = insightsFixtures("typical")["30d"].topEntities;
    fireEvent.click(nodes[0] as HTMLElement);
    fireEvent.keyDown(nodes[1] as HTMLElement, { key: "Enter" });
    const ranked = [...top].sort((a, b) => b.interactions - a.interactions);
    expect(navigate).toHaveBeenNthCalledWith(
      1,
      `/agent/soul?entity=${encodeURIComponent(ranked[0]?.entityId ?? "")}`,
    );
    expect(navigate).toHaveBeenNthCalledWith(
      2,
      `/agent/soul?entity=${encodeURIComponent(ranked[1]?.entityId ?? "")}`,
    );
  });

  it("switches between the map and its list equivalent", async () => {
    renderBoth({});
    await screen.findAllByTestId("people-node");
    fireEvent.click(screen.getByRole("button", { name: "Show as list" }));
    expect(screen.queryByTestId("people-map")).toBeNull();
    const rows = screen.getAllByTestId("people-row");
    expect(rows).toHaveLength(insightsFixtures("typical")["30d"].topEntities.length);
    fireEvent.click(screen.getByRole("button", { name: "Show map" }));
    expect(await screen.findByTestId("people-map")).toBeTruthy();
  });

  it("defaults to the list at compact width", async () => {
    renderBoth({ compact: true });
    expect(await screen.findByTestId("people-list")).toBeTruthy();
    expect(screen.queryByTestId("people-map")).toBeNull();
    expect(screen.getByRole("button", { name: "Show map" })).toBeTruthy();
  });

  it("has an empty state and a graph-paused state", async () => {
    renderBoth({
      edit: (w) => {
        typical(w);
        Object.assign(w, {
          insights: {
            "7d": emptyInsights("7d"),
            "30d": emptyInsights("30d"),
            all: emptyInsights("all"),
          },
        });
      },
    });
    expect(await screen.findByTestId("people-empty")).toBeTruthy();
    cleanup();
    renderBoth({ edit: (w) => typical(w, false) });
    await waitFor(() => expect(screen.getByTestId("people-paused")).toBeTruthy());
    expect(screen.queryByTestId("people-map")).toBeNull();
  });
});
