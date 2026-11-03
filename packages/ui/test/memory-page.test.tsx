import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { agentSheetRoute } from "../src/agent/AgentSheet.tsx";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { PEOPLE_IDS } from "../src/fixtures/people.ts";
import { legacyRedirect } from "../src/home/redirects.ts";
import { memoryHref, parseMemoryKind } from "../src/memory-page/kinds.ts";
import { MemoryScreen } from "../src/memory-page/MemoryScreen.tsx";
import { overviewRedirect } from "../src/overview/redirects.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/** The Memory page (docs/design/memory-everything-2026.md §6) against the MockGateway. */

function setup(ui: ReactElement, edit?: (w: FixtureWorld) => void) {
  const navigate = vi.fn();
  const user = userEvent.setup();
  render(
    <StoryWorld {...(edit ? { edit } : {})} slots={{ navigate }}>
      {ui}
    </StoryWorld>,
  );
  return { navigate, user };
}

describe("the Memory page", () => {
  it("has the kind chips in order, Everything current, and a Review link at the end", async () => {
    const { navigate, user } = setup(<MemoryScreen now={STORY_NOW} />);
    const kinds = await screen.findByRole("navigation", { name: "What to show" });
    const names = within(kinds)
      .getAllByRole("button")
      .map((b) => b.textContent?.replace(/\d+$/, ""));
    expect(names).toEqual([
      "Everything",
      "People",
      "Projects",
      "Work due",
      "Events",
      "More",
      "Review",
    ]);
    expect(
      within(kinds).getByRole("button", { name: "Everything" }).getAttribute("aria-current"),
    ).toBe("page");
    await user.click(within(kinds).getByRole("button", { name: "Projects" }));
    expect(navigate).toHaveBeenLastCalledWith("/memory?kind=projects");
    await user.click(within(kinds).getByRole("button", { name: /^Review/ }));
    expect(navigate).toHaveBeenLastCalledWith("/settings/memory");
  });

  it("People is the old People page: the list, its filters and a row that opens its page", async () => {
    const { navigate, user } = setup(<MemoryScreen kind="people" now={STORY_NOW} />);
    expect(await screen.findByRole("textbox", { name: "Search people and projects" })).toBeTruthy();
    for (const f of ["People", "Projects", "Suggestions", "Waiting on"])
      expect(screen.getByRole("radio", { name: f })).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: /^Sam Lee/ }));
    expect(navigate).toHaveBeenLastCalledWith(`/memory?entity=${PEOPLE_IDS.samLee}`);
  });

  it("opens an entity in the page, with Back to its list", async () => {
    const { navigate, user } = setup(<MemoryScreen entity={PEOPLE_IDS.samLee} now={STORY_NOW} />);
    expect(await screen.findByTestId("memory-entity")).toBeTruthy();
    expect(await screen.findByText("Sam Lee")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "What to show" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Back to People" }));
    expect(navigate).toHaveBeenLastCalledWith("/memory?kind=people");
  });

  it("shows a calm empty page for Work due", async () => {
    setup(<MemoryScreen kind="due" now={STORY_NOW} />);
    const due = await screen.findByTestId("memory-due");
    expect(within(due).getByText("Nothing due")).toBeTruthy();
  });

  it("Everything shows only the sections it can fill, and says so when there are none", async () => {
    setup(<MemoryScreen now={STORY_NOW} />);
    const all = await screen.findByTestId("memory-everything");
    expect(within(all).queryByRole("heading", { name: "Due soon" })).toBeNull();
    expect(within(all).getAllByRole("heading", { level: 2 }).length).toBeGreaterThan(0);
  });

  it("Everything is quiet when nothing is remembered", async () => {
    setup(<MemoryScreen now={STORY_NOW} />, (w) => {
      w.graph.entities = [];
    });
    expect(await screen.findByText(/^Nothing remembered yet/)).toBeTruthy();
  });

  it("reads the chip from ?kind= and falls back to Everything", () => {
    expect(parseMemoryKind("events")).toBe("events");
    expect(parseMemoryKind("nope")).toBe("everything");
    expect(parseMemoryKind(null)).toBe("everything");
    expect(memoryHref("everything")).toBe("/memory");
    expect(memoryHref("due")).toBe("/memory?kind=due");
  });
});

describe("old People routes", () => {
  it("show Memory in place", () => {
    expect(legacyRedirect("/people")).toBe("/memory?kind=people");
    expect(legacyRedirect("/people?entity=ent_1")).toBe("/memory?entity=ent_1");
    expect(legacyRedirect("/people?entity=a%2Fb")).toBe("/memory?entity=a%2Fb");
    expect(legacyRedirect("/agent/soul?entity=ent_1")).toBe("/memory?entity=ent_1");
    expect(legacyRedirect("/agent/soul?entity=ent_1#x")).toBe("/memory?entity=ent_1");
  });

  it("leave the Soul tab, the Memory page and everything else alone", () => {
    expect(legacyRedirect("/agent/soul")).toBeNull();
    expect(legacyRedirect("/agent/soul?file=SOUL.md")).toBeNull();
    expect(legacyRedirect("/agent/approvals")).toBeNull();
    expect(legacyRedirect("/memory?kind=due")).toBeNull();
    expect(legacyRedirect("/memory?entity=ent_1")).toBeNull();
    expect(legacyRedirect("/peopleish")).toBeNull();
  });

  it("never reach the sheet's own redirect, so Back cannot loop", () => {
    const routed = agentSheetRoute("/agent/soul?entity=ent_1");
    expect(routed && overviewRedirect(routed)).toBeNull();
    const target = legacyRedirect("/agent/soul?entity=ent_1") ?? "";
    expect(legacyRedirect(target)).toBeNull();
  });
});
