import { render, screen, waitFor, within } from "@testing-library/react";
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
  it("has two controls and a menu: People | Projects | Work, search, and …", async () => {
    const { navigate, user } = setup(<MemoryScreen now={STORY_NOW} />);
    const kinds = await screen.findByRole("group", { name: "What to show" });
    expect(
      within(kinds)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["People", "Projects", "Work"]);
    // People is the default.
    expect(within(kinds).getByRole("button", { name: "People" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("searchbox", { name: "Search Memory" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Memory menu" })).toBeTruthy();
    // No chip row, no Everything tab, no Soul or Review buttons in the toolbar.
    expect(screen.queryByTestId("memory-everything")).toBeNull();
    expect(screen.queryByRole("button", { name: "Soul" })).toBeNull();
    await user.click(within(kinds).getByRole("button", { name: "Projects" }));
    expect(navigate).toHaveBeenLastCalledWith("/memory?kind=projects");
    await user.click(within(kinds).getByRole("button", { name: "Work" }));
    expect(navigate).toHaveBeenLastCalledWith("/memory?kind=due");
  });

  it("keeps Map, Soul, Review, Events, More and Everything in the … menu", async () => {
    const { navigate, user } = setup(<MemoryScreen now={STORY_NOW} />);
    const reach = async (name: RegExp | string, to: string) => {
      await user.click(await screen.findByRole("button", { name: "Memory menu" }));
      await user.click(await screen.findByRole("menuitem", { name }));
      expect(navigate).toHaveBeenLastCalledWith(to);
    };
    await reach("Map", "/memory?view=map");
    await reach("Soul", "/agent/soul");
    await reach(/^Review/, "/memory/review");
    await reach("Events", "/memory?kind=events");
    await reach("More", "/memory?kind=more");
    await reach("Everything", "/memory?kind=everything");
  });

  it("shows the Review count on its menu item", async () => {
    setup(<MemoryScreen now={STORY_NOW} />);
    await userEvent.click(await screen.findByRole("button", { name: "Memory menu" }));
    expect(await screen.findByRole("menuitem", { name: /^Review/ })).toBeTruthy();
  });

  it("People: rows with one muted line, search in the toolbar, and a row that opens its page", async () => {
    const { navigate, user } = setup(<MemoryScreen kind="people" now={STORY_NOW} />);
    // The section draws no search field of its own; Projects has its own segment.
    expect(screen.queryByRole("textbox", { name: "Search people and projects" })).toBeNull();
    for (const f of ["Suggestions", "Waiting on"])
      expect(screen.getByRole("radio", { name: f })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Projects" })).toBeNull();
    const row = await screen.findByRole("button", { name: /^Sam Lee/ });
    // One fact plus the open-loop count; no "last talked" next to an org.
    expect(row.textContent).not.toMatch(/last talked/);
    await user.click(row);
    expect(navigate).toHaveBeenLastCalledWith(`/memory?entity=${PEOPLE_IDS.samLee}`);
  });

  it("the toolbar search narrows the people", async () => {
    const { user } = setup(<MemoryScreen kind="people" now={STORY_NOW} />);
    await screen.findByRole("button", { name: /^Sam Lee/ });
    await user.type(screen.getByRole("searchbox", { name: "Search Memory" }), "Dana");
    await screen.findByRole("button", { name: /^Dana Kim/ });
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Sam Lee/ })).toBeNull());
    expect(screen.queryByRole("button", { name: /^Sam Lee/ })).toBeNull();
  });

  it("opens an entity in the page, with Back to its list", async () => {
    const { navigate, user } = setup(<MemoryScreen entity={PEOPLE_IDS.samLee} now={STORY_NOW} />);
    expect(await screen.findByTestId("memory-entity")).toBeTruthy();
    expect(await screen.findByText("Sam Lee")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Back to People" }));
    expect(navigate).toHaveBeenLastCalledWith("/memory?kind=people");
  });

  it("shows a calm empty page for Work due", async () => {
    setup(<MemoryScreen kind="due" now={STORY_NOW} />);
    const due = await screen.findByTestId("memory-due");
    expect(within(due).getByText("Nothing due")).toBeTruthy();
  });

  it("Everything is reached from the … menu and shows only the sections it can fill", async () => {
    setup(<MemoryScreen kind="everything" now={STORY_NOW} />);
    const all = await screen.findByTestId("memory-everything");
    expect(within(all).queryByRole("heading", { name: "Due soon" })).toBeNull();
    expect(within(all).getAllByRole("heading", { level: 2 }).length).toBeGreaterThan(0);
  });

  it("Everything is quiet when nothing is remembered", async () => {
    setup(<MemoryScreen kind="everything" now={STORY_NOW} />, (w) => {
      w.graph.entities = [];
    });
    expect(await screen.findByText(/^Nothing remembered yet/)).toBeTruthy();
  });

  it("reads the kind from ?kind= and falls back to People", () => {
    expect(parseMemoryKind("events")).toBe("events");
    expect(parseMemoryKind("everything")).toBe("everything");
    expect(parseMemoryKind("nope")).toBe("people");
    expect(parseMemoryKind(null)).toBe("people");
    expect(memoryHref("everything")).toBe("/memory?kind=everything");
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
