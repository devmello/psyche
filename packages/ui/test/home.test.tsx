import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { agentSheetRoute } from "../src/agent/AgentSheet.tsx";
import { type FixtureWorld, IDS } from "../src/fixtures/index.ts";
import { HomeScreen } from "../src/home/HomeScreen.tsx";
import { overviewRedirect } from "../src/overview/redirects.ts";
import { PeopleScreen } from "../src/people/PeopleScreen.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/** Home and People (docs/design/consolidation-2026.md §3.1, §3.2) against the MockGateway. */

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

const section = (id: string) => screen.findByTestId(`section-${id}`);

describe("Home", () => {
  it("puts what needs you first, amber, with a way to the whole inbox", async () => {
    const { navigate, user } = setup(<HomeScreen now={STORY_NOW} />);
    const needs = await section("needs-you");
    expect(within(needs).getByRole("heading", { name: "Needs you" })).toBeTruthy();
    expect(await within(needs).findByRole("button", { name: /^Approve/ })).toBeTruthy();
    await user.click(within(needs).getByRole("button", { name: "All notifications" }));
    expect(navigate).toHaveBeenCalledWith("/inbox");
  });

  it("holds the brief, suggestions, coming up and goals that used to be pages", async () => {
    setup(<HomeScreen now={STORY_NOW} />);
    for (const id of ["today", "suggestions", "coming-up", "goals", "more"])
      expect(await section(id)).toBeTruthy();
    const today = await section("today");
    await waitFor(() => expect(within(today).getAllByRole("listitem").length).toBeGreaterThan(0));
  });

  it("gives the accent to the first Approve, so the first idea is an outline button", async () => {
    setup(<HomeScreen now={STORY_NOW} />);
    const suggestions = await section("suggestions");
    await waitFor(() =>
      expect(
        within(suggestions).queryAllByRole("button", { name: "Do it" }).length,
      ).toBeGreaterThan(0),
    );
    expect(suggestions.querySelector("[data-prominent]")).toBeNull();
  });

  it("opens a goal's page and Scheduled from their rows", async () => {
    const { navigate, user } = setup(<HomeScreen now={STORY_NOW} />);
    const goals = await section("goals");
    const first = await within(goals).findAllByRole("button", { name: /.+/ });
    const row = first.find((b) => b.closest("li") !== null) as HTMLElement;
    await user.click(row);
    expect(navigate.mock.calls.at(-1)?.[0]).toMatch(/^\/goals\/.+/);
    const comingUp = await section("coming-up");
    await user.click(within(comingUp).getByRole("button", { name: "Scheduled" }));
    expect(navigate).toHaveBeenLastCalledWith("/scheduled");
  });

  it("leaves out what has nothing to say on a quiet day", async () => {
    setup(<HomeScreen now={STORY_NOW} />, (w) => {
      w.notifications = [];
      w.ideas = [];
      w.goals = [];
    });
    expect(await section("goals")).toBeTruthy();
    expect(screen.queryByTestId("section-needs-you")).toBeNull();
    expect(screen.queryByTestId("section-suggestions")).toBeNull();
    expect(screen.queryByTestId("section-keep-in-touch")).toBeNull();
  });
});

describe("Home's one way in (consolidation-2026 §7)", () => {
  it("sends a question to the main chat and opens it", async () => {
    let calls: { method: string; params: unknown }[] = [];
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(
      <StoryWorld
        slots={{ navigate }}
        onGateway={(g) => {
          calls = g.calls as typeof calls;
        }}
      >
        <HomeScreen now={STORY_NOW} />
      </StoryWorld>,
    );
    const field = await screen.findByRole("textbox", { name: "Ask Wren anything" });
    await user.type(field, "What is on today?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/chat"));
    const sent = calls.find((c) => c.method === "chat.send");
    expect(sent?.params).toMatchObject({
      threadId: IDS.threads.main,
      content: "What is on today?",
    });
  });

  it("offers things to try only before anything has been said", async () => {
    setup(<HomeScreen now={STORY_NOW} />);
    await screen.findByTestId("section-ask");
    expect(screen.queryByTestId("home-starters")).toBeNull();
  });

  it("shows starters to a first-time owner, without asking them to set up access", async () => {
    setup(<HomeScreen now={STORY_NOW} />, (w) => {
      w.threads = w.threads
        .filter((e) => e.thread.kind === "main")
        .map((e) => ({ ...e, thread: { ...e.thread, lastMessageAt: null } }));
    });
    const starters = await screen.findByTestId("home-starters");
    const names = within(starters)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names).toEqual([
      "Plan my week",
      "Set up a morning brief",
      "Tell Wren about you",
      "What can you do?",
    ]);
    expect(starters.textContent).not.toMatch(/connect|permission|access/i);
  });

  it("keeps the deeper pages one step away under More", async () => {
    const { navigate, user } = setup(<HomeScreen now={STORY_NOW} />);
    const more = await section("more");
    await user.click(within(more).getByRole("button", { name: /^Scheduled/ }));
    expect(navigate).toHaveBeenLastCalledWith("/scheduled");
    for (const name of [/^Wren & you/, /^Inbox/, /^Soul & Memory/, /^Memory review/])
      expect(within(more).getByRole("button", { name })).toBeTruthy();
  });
});

describe("People", () => {
  it("is the people list at page width, with a way to Soul & Memory", async () => {
    const { navigate, user } = setup(<PeopleScreen />);
    expect(await screen.findByRole("textbox", { name: "Search people and projects" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Soul & memory" }));
    expect(navigate).toHaveBeenCalledWith("/agent/soul");
  });

  it("is where the old Soul & Memory person links go", () => {
    const routed = agentSheetRoute("/agent/soul?entity=ent_1");
    expect(routed && overviewRedirect(routed)).toBe("/people?entity=ent_1");
    const plain = agentSheetRoute("/agent/soul");
    expect(plain && overviewRedirect(plain)).toBeNull();
  });
});
