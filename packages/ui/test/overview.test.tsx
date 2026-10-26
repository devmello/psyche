import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatPeriodRange,
  isNewUser,
  OVERVIEW_SECTIONS,
  OverviewScreen,
  overviewHref,
  parseOverviewPeriod,
} from "../src/overview/index.ts";
import { destinationFor, RAIL_ITEMS } from "../src/shell/Rail.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const DAY = 24 * 60 * 60 * 1000;
const SIX_WEEKS_AGO = new Date(STORY_NOW - 42 * DAY).toISOString();

function renderOverview(props: Partial<Parameters<typeof OverviewScreen>[0]> = {}) {
  const onPeriodChange = vi.fn();
  render(
    <StoryWorld>
      <OverviewScreen
        period="7d"
        onPeriodChange={onPeriodChange}
        data={{ firstActivityAt: SIX_WEEKS_AGO }}
        now={STORY_NOW}
        {...props}
      />
    </StoryWorld>,
  );
  return { onPeriodChange };
}

describe("the period in the URL", () => {
  it("parses ?period= and falls back to the week", () => {
    expect(parseOverviewPeriod("/overview?period=30d")).toBe("30d");
    expect(parseOverviewPeriod("/overview?period=all")).toBe("all");
    expect(parseOverviewPeriod("period=7d")).toBe("7d");
    expect(parseOverviewPeriod("/overview")).toBe("7d");
    expect(parseOverviewPeriod("/overview?period=year")).toBe("7d");
  });

  it("writes it back, leaving the default clean", () => {
    expect(overviewHref("7d")).toBe("/overview");
    expect(overviewHref("30d")).toBe("/overview?period=30d");
    expect(overviewHref("all")).toBe("/overview?period=all");
  });

  it("formats the exact range, ending today", () => {
    expect(formatPeriodRange("7d", STORY_NOW)).toMatch(/\d/);
    expect(formatPeriodRange("all", STORY_NOW, null)).toBe("All time");
    expect(formatPeriodRange("all", STORY_NOW, SIX_WEEKS_AGO)).toMatch(/^Since /);
  });
});

describe("navigation entry", () => {
  it("is a rail destination after Library, and /overview routes belong to it", () => {
    const ids = RAIL_ITEMS.map((i) => i.id);
    expect(ids.indexOf("overview")).toBe(ids.indexOf("library") + 1);
    expect(destinationFor("/overview")).toBe("overview");
    expect(destinationFor("/overview?period=all")).toBe("overview");
    expect(destinationFor("/overview/run/01J")).toBe("overview");
  });
});

describe("OverviewScreen", () => {
  it("titles the page with the persona and offers Week / Month / All time", () => {
    const { onPeriodChange } = renderOverview();
    expect(screen.getByRole("heading", { level: 1, name: "Wren & you" })).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: "Time period" });
    const week = within(group).getByRole("radio", { name: "Week" });
    expect(week.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(group).getByRole("radio", { name: "Month" }));
    expect(onPeriodChange).toHaveBeenCalledWith("30d");
    expect(screen.getByTestId("overview-range").textContent).toMatch(/\d/);
  });

  it("renders every section anchor as a framed card and lists them in the jump bar", async () => {
    renderOverview();
    // Specialists appears once its roles load (it is hidden while none is enabled).
    await screen.findByTestId("overview-specialists");
    for (const id of OVERVIEW_SECTIONS) {
      const section = document.getElementById(id);
      expect(section, id).not.toBeNull();
      expect(section?.querySelector('[data-card="framed"]')).not.toBeNull();
    }
    const jump = screen.getByTestId("overview-jump");
    expect(
      within(jump)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(OVERVIEW_SECTIONS.map((id) => `#${id}`));
    expect(screen.queryByTestId("overview-new-user")).toBeNull();
  });

  it("shows the getting-to-know-you state for a new user, keeping Now and Upcoming", () => {
    const onTry = vi.fn();
    renderOverview({ data: { firstActivityAt: null }, onTry });
    const hero = screen.getByTestId("overview-new-user");
    expect(within(hero).getByText("Wren is getting to know you")).toBeTruthy();
    expect(OVERVIEW_SECTIONS.filter((id) => document.getElementById(id))).toEqual([
      "now",
      "upcoming",
    ]);
    fireEvent.click(within(hero).getByRole("button", { name: "Connect your mail" }));
    expect(onTry).toHaveBeenCalledWith("connectMail");
  });

  it("applies the 7-day threshold", () => {
    expect(isNewUser(null, STORY_NOW)).toBe(true);
    expect(isNewUser(new Date(STORY_NOW - 3 * DAY).toISOString(), STORY_NOW)).toBe(true);
    expect(isNewUser(new Date(STORY_NOW - 8 * DAY).toISOString(), STORY_NOW)).toBe(false);
    // Unknown (the seam isn't wired yet) is the regular page, not the new-user state.
    expect(isNewUser(undefined, STORY_NOW)).toBe(false);
  });
});
