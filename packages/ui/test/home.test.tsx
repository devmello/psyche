import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { type FixtureWorld, IDS } from "../src/fixtures/index.ts";
import { HomeScreen } from "../src/home/HomeScreen.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/** Home (docs/design/consolidation-2026.md §3.1) against the MockGateway. */

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
    await screen.findByTestId("section-ask");
    await new Promise((r) => setTimeout(r, 100));
    for (const id of ["goals", "needs-you"])
      expect(screen.queryByTestId(`section-${id}`)).toBeNull();
    expect(screen.queryByTestId("section-suggestions")).toBeNull();
    expect(screen.queryByTestId("section-keep-in-touch")).toBeNull();
  });
});

describe("Home's reading order and length", () => {
  it("lists the sections in one order, top to bottom", async () => {
    setup(<HomeScreen now={STORY_NOW} />, (w) => {
      w.review = {
        ...(w.review ?? { items: [], quarantine: [], runs: [] }),
        nudges: {
          items: [
            {
              id: "nd1",
              kind: "birthday",
              entityId: "ent_alex",
              name: "Alex Kim",
              text: "Alex Kim's birthday is on Thursday",
              daysAgo: null,
              channel: null,
              date: "2026-10-22",
              overdue: false,
            },
          ],
          muted: [],
        },
      };
    });
    const ids = [
      "ask",
      "needs-you",
      "today",
      "suggestions",
      "coming-up",
      "goals",
      "keep-in-touch",
      "more",
    ];
    for (const id of ids) await section(id);
    const order = [...document.querySelectorAll("[data-testid^='section-']")].map((e) =>
      e.getAttribute("data-testid")?.replace("section-", ""),
    );
    expect(order.filter((id) => ids.includes(id ?? ""))).toEqual(ids);
    // One column: no complementary landmark beside the page.
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("stops the brief at three posts and the suggestions at two, and says how many more", async () => {
    const { user } = setup(<HomeScreen now={STORY_NOW} />);
    const today = await section("today");
    const posts = () => today.querySelectorAll("#feed-posts > li");
    await waitFor(() => expect(posts().length).toBe(3));
    const more = within(today).getByRole("button", { name: /^Show \d+ more$/ });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(within(today).queryByText(/That’s it for today|That's it for today/)).toBeNull();
    await user.click(more);
    expect(posts().length).toBeGreaterThan(3);
    expect(within(today).getByRole("button", { name: "Show less" })).toBeTruthy();
    const suggestions = await section("suggestions");
    await waitFor(() =>
      expect(within(suggestions).getByRole("button", { name: /^Show \d+ more$/ })).toBeTruthy(),
    );
  });

  it("leaves out an empty brief, and keeps its settings one link away", async () => {
    const { navigate, user } = setup(<HomeScreen now={STORY_NOW} />, (w) => {
      w.feed = [];
    });
    const more = await section("more");
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByTestId("section-today")).toBeNull();
    await user.click(within(more).getByRole("button", { name: "Brief settings" }));
    expect(navigate).toHaveBeenLastCalledWith("/home/instructions");
  });

  it("draws Catching up at the top of Today when it has rows, soonest due first", async () => {
    setup(
      <HomeScreen
        now={STORY_NOW}
        catchUp={[
          {
            id: "b",
            kind: "assignment",
            title: "Later thing",
            line: "Later.",
            dueAt: "2026-10-30T12:00:00Z",
          },
          {
            id: "a",
            kind: "assignment",
            title: "Essay",
            line: "Outline done.",
            dueAt: "2026-10-22T12:00:00Z",
          },
          { id: "c", kind: "mail", title: "Reply to Dr. Ellis", line: "Waiting." },
        ]}
      />,
    );
    const block = await screen.findByTestId("catch-up");
    const titles = within(block)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(titles[0]).toMatch(/^Essay/);
    expect(titles[2]).toMatch(/^Reply to Dr. Ellis/);
    const today = await section("today");
    expect(today.contains(block)).toBe(true);
    expect(within(today).getByRole("heading", { name: "Catching up" })).toBeTruthy();
  });

  it("is only the Ask field and the links on a first visit", async () => {
    setup(<HomeScreen now={STORY_NOW} />, (w) => {
      w.notifications = [];
      w.feed = [];
      w.ideas = [];
      w.goals = [];
      w.automations = [];
      w.threads = w.threads
        .filter((e) => e.thread.kind === "main")
        .map((e) => ({ ...e, thread: { ...e.thread, lastMessageAt: null } }));
    });
    await screen.findByTestId("home-starters");
    await new Promise((r) => setTimeout(r, 100));
    const drawn = [...document.querySelectorAll("[data-testid^='section-']")].map((e) =>
      e.getAttribute("data-testid"),
    );
    expect(drawn).toEqual(["section-ask", "section-more"]);
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
    for (const name of [/^Wren & you/, /^Inbox/, /^Soul/, /^Memory review/])
      expect(within(more).getByRole("button", { name })).toBeTruthy();
  });
});
