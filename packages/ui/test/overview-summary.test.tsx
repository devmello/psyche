import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insightsFixtures } from "../src/fixtures/index.ts";
import { OverviewScreen } from "../src/overview/index.ts";
import { parseRecentFilter, recentHref, useRecentFilter } from "../src/overview/recentFilter.ts";
import { insightsWorld } from "../src/overview/storyWorld.ts";
import {
  approvalsDecided,
  comparisonKey,
  hasNoRuns,
  okPercent,
  summaryKinds,
  taskSpark,
  tasksDone,
} from "../src/overview/summaryModel.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const DAY = 24 * 60 * 60 * 1000;
const SIX_WEEKS_AGO = new Date(STORY_NOW - 42 * DAY).toISOString();

describe("the Recent runs filter in the URL", () => {
  it("round-trips filter and day and leaves defaults out", () => {
    expect(recentHref("7d")).toBe("/overview");
    expect(recentHref("30d", { filter: "failed" })).toBe("/overview?period=30d&filter=failed");
    expect(recentHref("7d", { day: "2026-10-14" })).toBe("/overview?day=2026-10-14");
    expect(recentHref("30d", { filter: "tasks", status: "done" })).toBe(
      "/overview?period=30d&filter=tasks&status=done",
    );
    expect(parseRecentFilter("/overview?period=30d&filter=tasks&status=done")).toEqual({
      filter: "tasks",
      status: "done",
      day: null,
    });
    expect(parseRecentFilter("/overview?period=30d&filter=failed&day=2026-10-14")).toEqual({
      filter: "failed",
      status: null,
      day: "2026-10-14",
    });
    expect(parseRecentFilter("filter=tasks#recent").filter).toBe("tasks");
  });

  it("ignores anything it does not know", () => {
    expect(parseRecentFilter("/overview?filter=bogus&status=weird&day=yesterday")).toEqual({
      filter: "all",
      status: null,
      day: null,
    });
    expect(recentHref("7d", { day: "nope" })).toBe("/overview");
  });

  it("useRecentFilter reads the route and writes with the period kept", () => {
    const navigate = vi.fn();
    const { result } = renderHook(() =>
      useRecentFilter("/overview?period=30d&filter=chat", "30d", navigate),
    );
    expect(result.current[0].filter).toBe("chat");
    result.current[1]({ filter: "failed" });
    expect(navigate).toHaveBeenCalledWith("/overview?period=30d&filter=failed");
  });
});

describe("summary maths", () => {
  const month = insightsFixtures("typical")["30d"];

  it("counts tasks done as task plus chat runs with status done, and approvals as decided", () => {
    const t = month.totals;
    expect(tasksDone(t)).toBe(t.runsByKind.task.done + t.runsByKind.chat.done);
    expect(tasksDone(t)).toBeLessThanOrEqual(t.runs.task + t.runs.chat);
    expect(approvalsDecided(t)).toBe(
      t.approvals.approved + t.approvals.denied + t.approvals.expired,
    );
    expect(taskSpark(month.days)).toHaveLength(30);
  });

  it("never rounds a failure up to 100%", () => {
    expect(okPercent(999, 1)).toBe(99);
    expect(okPercent(10, 0)).toBe(100);
    expect(okPercent(0, 0)).toBeNull();
  });

  it("drops a clause when its number is 0", () => {
    const base = month.totals;
    const none = { done: 0, failed: 0 };
    const zero = {
      ...base,
      runs: { ...base.runs, task: 0, chat: 0, automation: 0 },
      runsByKind: { ...base.runsByKind, task: none, chat: none, automation: none },
    };
    expect(summaryKinds(base)).toBe("both");
    expect(
      summaryKinds({ ...zero, runsByKind: { ...zero.runsByKind, task: { done: 3, failed: 0 } } }),
    ).toBe("tasks");
    expect(summaryKinds({ ...zero, runs: { ...zero.runs, automation: 2 } })).toBe("automations");
    expect(summaryKinds(zero)).toBe("none");
  });

  it("compares only a week or a month, never all time", () => {
    expect(comparisonKey("7d")).toBe("overview.summary.vs.week");
    expect(comparisonKey("30d")).toBe("overview.summary.vs.month");
    expect(comparisonKey("all")).toBeNull();
    expect(hasNoRuns(insightsFixtures("typical")["7d"].days)).toBe(false);
  });
});

function renderPage(
  period: "7d" | "30d" | "all",
  state: "new" | "typical" | "heavy" | null = "typical",
  onNavigate = vi.fn(),
) {
  render(
    <StoryWorld edit={insightsWorld(state)}>
      <OverviewScreen
        period={period}
        onPeriodChange={() => {}}
        onNavigate={onNavigate}
        data={{ firstActivityAt: SIX_WEEKS_AGO }}
        now={STORY_NOW}
      />
    </StoryWorld>,
  );
  return { onNavigate };
}

describe("Summary", () => {
  it("states the totals in a sentence and shows four tiles that link to the items", async () => {
    const { onNavigate } = renderPage("30d");
    const sentence = await screen.findByTestId("overview-summary-sentence");
    const totals = insightsFixtures("typical")["30d"].totals;
    expect(sentence.textContent).toContain("This month");
    expect(sentence.textContent).toContain(String(totals.runs.automation));

    const tasks = await screen.findByTestId("overview-tile-tasks");
    expect(within(tasks).getByRole("link").getAttribute("href")).toBe(
      "/overview?period=30d&filter=tasks&status=done",
    );
    fireEvent.click(within(tasks).getByRole("link"));
    expect(onNavigate).toHaveBeenCalledWith("/overview?period=30d&filter=tasks&status=done");

    expect(within(tasks).getByText("Tasks done")).toBeTruthy();
    const autos = screen.getByTestId("overview-tile-automations");
    expect(within(autos).getByTestId("overview-run-health").textContent).toMatch(/ok/);
    const failed = within(autos).getByRole("link", { name: /failed/ });
    expect(failed.getAttribute("href")).toBe("/overview?period=30d&filter=failed");

    const approvals = screen.getByTestId("overview-tile-approvals");
    expect(within(approvals).getByRole("link").getAttribute("href")).toContain("/agent/approvals");
    expect(within(approvals).getByTestId("overview-decisions").textContent).toMatch(/approved/);
    await waitFor(() => screen.getByTestId("overview-tile-lessons"));
  });

  it("shows deltas against a week or month, and none for all time", async () => {
    renderPage("30d");
    const tile = await screen.findByTestId("overview-tile-tasks");
    expect(within(tile).getByTestId("stat-tile-delta").textContent).toMatch(/last month/);
    cleanup();
    renderPage("all", "heavy");
    const all = await screen.findByTestId("overview-tile-tasks");
    expect(within(all).queryByTestId("stat-tile-delta")).toBeNull();
  });

  it("says nothing ran, with no clauses, for an empty period", async () => {
    renderPage("7d", null);
    const sentence = await screen.findByTestId("overview-summary-sentence");
    expect(sentence.textContent).toMatch(/^Nothing ran this week\./);
  });
});

describe("Activity", () => {
  it("draws stacked bars for a month with the facts under them", async () => {
    const { onNavigate } = renderPage("30d");
    const chart = await screen.findByTestId("overview-activity-bars");
    expect(within(chart).getAllByRole("button", { pressed: false })).toHaveLength(30);
    const facts = await screen.findByTestId("overview-activity-facts");
    expect(within(facts).getByTestId("overview-fact-busiest").textContent).toMatch(/Busiest day/);
    expect(within(facts).getByTestId("overview-fact-worked").textContent).toMatch(
      /measured run time/,
    );
    expect(within(facts).getByTestId("overview-fact-top-automation").textContent).toMatch(
      /Morning brief/,
    );
    const day = insightsFixtures("typical")["30d"].totals.busiestDay?.date ?? "";
    fireEvent.click(within(facts).getByRole("link", { name: /Busiest day/ }));
    expect(onNavigate).toHaveBeenCalledWith(`/overview?period=30d&day=${day}`);
  });

  it("draws the calendar for all time", async () => {
    renderPage("all", "heavy");
    expect(await screen.findByTestId("overview-activity-heatmap")).toBeTruthy();
  });

  it("states an empty period and mentions run time nowhere else on the page", async () => {
    renderPage("7d", null);
    expect((await screen.findByTestId("overview-activity-empty")).textContent).toBe(
      "Nothing this week.",
    );
    cleanup();
    renderPage("30d");
    await screen.findByTestId("overview-activity-facts");
    expect(screen.getAllByText(/measured run time/)).toHaveLength(1);
  });
});
