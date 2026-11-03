import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureWorld, type FixtureWorld, IDS } from "../src/fixtures/index.ts";
import { withCatchUp } from "../src/fixtures/work.ts";
import { HomeScreen } from "../src/home/HomeScreen.tsx";
import { legacyRedirect } from "../src/home/redirects.ts";
import { ROUTE_REPEAT_EVENT } from "../src/home/route-repeat.ts";
import { feedKind } from "../src/screens/feed/feed-post.ts";
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

  it("draws Catching up at the top of Today from memory.catchup.list, in the Gateway's order", async () => {
    setup(<HomeScreen now={STORY_NOW} />, withCatchUp);
    const block = await screen.findByTestId("catch-up");
    const rows = within(block)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    // The past-due question is in Needs you, so two lines are left, still in the Gateway's order.
    expect(rows).toEqual([
      "Kitchen remodel · Order cabinet hardware: due Tue, not started, as of Fri.",
      "Pay rent: due Nov 1, not started.",
    ]);
    const today = await section("today");
    expect(today.contains(block)).toBe(true);
    expect(within(today).getByRole("heading", { name: "Catching up" })).toBeTruthy();
  });

  it("shows at most three lines, and asks the Gateway for no more", async () => {
    let calls: { method: string; params: unknown }[] = [];
    render(
      <StoryWorld
        edit={(w) => {
          withCatchUp(w);
          const base = (w.graph.catchUp ?? []).filter((i) => i.ask !== true);
          // A Gateway that sent more than it was asked for still gets three drawn.
          w.graph.catchUp = [0, 1, 2, 3].flatMap((n) =>
            base.map((i) => ({ ...i, entityId: `${i.entityId}_${n}` })),
          );
        }}
        onGateway={(g) => {
          calls = g.calls as typeof calls;
        }}
      >
        <HomeScreen now={STORY_NOW} />
      </StoryWorld>,
    );
    const block = await screen.findByTestId("catch-up");
    expect(within(block).getAllByRole("listitem").length).toBe(3);
    expect(calls.find((c) => c.method === "memory.catchup.list")?.params).toEqual({
      surface: "home",
      limit: 3,
    });
  });

  it("draws no Catching up when there is nothing to catch up on", async () => {
    setup(<HomeScreen now={STORY_NOW} />);
    await section("today");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("catching-up")).toBeNull();
    expect(screen.queryByTestId("past-due-asks")).toBeNull();
  });

  it("counts work waiting to be confirmed, never listing it", async () => {
    const { navigate, user } = setup(<HomeScreen now={STORY_NOW} />, (w) => {
      w.graph.catchUp = [];
      w.graph.catchUpPending = 2;
    });
    const pending = await screen.findByTestId("catch-up-pending");
    expect(pending.textContent).toBe("2 new items to confirm");
    await user.click(within(pending).getByRole("button"));
    expect(navigate).toHaveBeenCalledWith("/memory/review");
  });

  it("opens a line on its page in Memory, and all work due from the heading", async () => {
    const { navigate, user } = setup(<HomeScreen now={STORY_NOW} />, withCatchUp);
    const block = await screen.findByTestId("catching-up");
    await user.click(within(block).getByRole("button", { name: "Open Pay rent" }));
    expect(navigate).toHaveBeenLastCalledWith("/memory?entity=ent_pay_rent");
    await user.click(within(block).getByRole("button", { name: "All work due" }));
    expect(navigate).toHaveBeenLastCalledWith("/memory?kind=due");
  });

  it("puts the past-due question in Needs you, amber, and nowhere else", async () => {
    setup(<HomeScreen now={STORY_NOW} />, withCatchUp);
    const needs = await section("needs-you");
    const ask = await within(needs).findByTestId("past-due-ask");
    expect(ask.textContent).toContain("Did you finish Sign off on the launch copy?");
    // Amber (the needs-you tokens) is on the ask and its "Past due" mark only.
    expect(ask.innerHTML).toMatch(/approval-text/);
    const block = await screen.findByTestId("catching-up");
    expect(block.innerHTML).not.toMatch(/approval|amber/);
    // The question is not repeated as a line of Catching up.
    expect(block.textContent).not.toContain("Did you finish");
    // It counts toward what is waiting.
    expect(within(needs).getByText(/waiting/).textContent).toMatch(/^\d+ waiting$/);
  });

  it("answers the question with Still working, and it leaves Needs you", async () => {
    let calls: { method: string; params: unknown }[] = [];
    const user = userEvent.setup();
    render(
      <StoryWorld
        edit={withCatchUp}
        onGateway={(g) => {
          calls = g.calls as typeof calls;
        }}
      >
        <HomeScreen now={STORY_NOW} />
      </StoryWorld>,
    );
    const ask = await screen.findByTestId("past-due-ask");
    await user.click(
      within(ask).getByRole("button", { name: "Still working on “Sign off on the launch copy”" }),
    );
    await waitFor(() => expect(screen.queryByTestId("past-due-ask")).toBeNull());
    expect(calls.find((c) => c.method === "memory.catchup.act")?.params).toEqual({
      entityId: "ent_signoff",
      action: "still_working",
    });
  });

  it("marks a to-do handed in from the question", async () => {
    let calls: { method: string; params: unknown }[] = [];
    const user = userEvent.setup();
    render(
      <StoryWorld
        edit={withCatchUp}
        onGateway={(g) => {
          calls = g.calls as typeof calls;
        }}
      >
        <HomeScreen now={STORY_NOW} />
      </StoryWorld>,
    );
    const ask = await screen.findByTestId("past-due-ask");
    await user.click(within(ask).getByRole("button", { name: /handed in/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "memory.catchup.act")?.params).toEqual({
        entityId: "ent_signoff",
        action: "submitted",
      }),
    );
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

describe("an old Feed route lands on its post", () => {
  it("carries the post id to Home, and keeps the plain Feed on Today", () => {
    expect(legacyRedirect("/feed/post_1")).toBe("/home?post=post_1#today");
    expect(legacyRedirect("/feed/post_1?x=1#y")).toBe("/home?post=post_1#today");
    expect(legacyRedirect("/feed/a%2Fb")).toBe("/home?post=a%2Fb#today");
    expect(legacyRedirect("/feed/a b")).toBe("/home?post=a%20b#today");
    expect(legacyRedirect("/feed/%E0%A4%A")).toBe("/home?post=%25E0%25A4%25A#today");
    expect(legacyRedirect("/feed")).toBe("/home#today");
    expect(legacyRedirect("/feed/instructions")).toBe("/home/instructions");
  });

  it("leaves the target alone, so Back cannot loop", () => {
    expect(legacyRedirect(legacyRedirect("/feed/post_1") ?? "")).toBeNull();
  });
});

describe("Home lands on a post of Today", () => {
  const scrolled: Element[] = [];
  beforeEach(() => {
    scrolled.length = 0;
    // jsdom has no layout: record what was scrolled into view instead.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
  });
  afterEach(() => {
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = undefined;
  });

  const ordered = () => {
    const posts = createFixtureWorld().feed;
    return [
      ...posts.filter((p) => feedKind(p) === "briefing"),
      ...posts.filter((p) => feedKind(p) !== "briefing"),
    ];
  };
  const postEl = (id: string) =>
    waitFor(() => {
      const el = document.getElementById(`post-${id}`);
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });

  it("scrolls to a visible post, focuses it and flashes it", async () => {
    const id = ordered()[0]?.id ?? "";
    setup(<HomeScreen now={STORY_NOW} anchor="today" post={id} />);
    const li = await postEl(id);
    await waitFor(() => expect(scrolled).toContain(li));
    expect(li.getAttribute("data-landed")).toBe("true");
    expect(document.activeElement).toBe(li);
    // The section's own scroll to the top of Today does not take the post's place.
    expect(scrolled.at(-1)).toBe(li);
  });

  it("opens Show more when the post is hidden behind it", async () => {
    const posts = ordered();
    expect(posts.length).toBeGreaterThan(3);
    const id = posts.at(-1)?.id ?? "";
    setup(<HomeScreen now={STORY_NOW} anchor="today" post={id} />);
    const li = await postEl(id);
    await waitFor(() => expect(li.getAttribute("data-landed")).toBe("true"));
    expect(scrolled).toContain(li);
    const today = await section("today");
    expect(within(today).getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("lets the owner collapse the list again after landing", async () => {
    const id = ordered().at(-1)?.id ?? "";
    const { user } = setup(<HomeScreen now={STORY_NOW} anchor="today" post={id} />);
    const today = await section("today");
    await user.click(await within(today).findByRole("button", { name: "Show less" }));
    expect(within(today).getByRole("button", { name: /^Show \d+ more$/ })).toBeTruthy();
    expect(document.getElementById(`post-${id}`)).toBeNull();
  });

  it("falls back to Today when the post no longer exists", async () => {
    setup(<HomeScreen now={STORY_NOW} anchor="today" post="post_gone" />);
    const today = await section("today");
    await waitFor(() => expect(within(today).getAllByRole("listitem").length).toBeGreaterThan(0));
    await waitFor(() => expect(scrolled).toContain(today));
    expect(document.querySelector("[data-landed]")).toBeNull();
  });

  it("scrolls again when the same route is asked for again", async () => {
    const id = ordered()[0]?.id ?? "";
    setup(<HomeScreen now={STORY_NOW} anchor="today" post={id} />);
    const li = await postEl(id);
    await waitFor(() => expect(scrolled).toContain(li));
    scrolled.length = 0;
    act(() => {
      document.dispatchEvent(new CustomEvent(ROUTE_REPEAT_EVENT));
    });
    await waitFor(() => expect(scrolled).toContain(li));
    expect(li.getAttribute("data-landed")).toBe("true");
  });

  it("scrolls to a section again when its link is asked for on Home", async () => {
    setup(<HomeScreen now={STORY_NOW} anchor="today" />);
    const today = await section("today");
    await waitFor(() => expect(scrolled).toContain(today));
    scrolled.length = 0;
    act(() => {
      document.dispatchEvent(new CustomEvent(ROUTE_REPEAT_EVENT));
    });
    await waitFor(() => expect(scrolled).toContain(today));
  });
});
