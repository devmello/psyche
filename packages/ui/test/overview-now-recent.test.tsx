import type { UpcomingItem } from "@psyche/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSheetRoute } from "../src/agent/AgentSheet.tsx";
import { applyRunTrace } from "../src/fixtures/runs.ts";
import {
  cadenceMs,
  dayOffset,
  groupUpcoming,
  isFrequent,
  matchesRecent,
  NowSection,
  OverviewRun,
  overviewAnchor,
  overviewRedirect,
  overviewRunHref,
  RecentSection,
  recentRunsQuery,
  UpcomingSection,
} from "../src/overview/index.ts";
import { STORY_NOW, StoryWorld, type StoryWorldProps } from "../src/stories/harness.tsx";

afterEach(cleanup);

const HOUR = 3_600_000;

describe("the recent filter's query", () => {
  const NOW = STORY_NOW;
  const none = { filter: "all", status: null, day: null } as const;

  it("asks the Gateway for finished runs in the period, narrowed by outcome or kind", () => {
    const since = new Date(NOW - 29 * 24 * HOUR).toISOString();
    expect(recentRunsQuery("30d", none, NOW)).toEqual({
      status: ["done", "failed", "cancelled"],
      since,
    });
    expect(
      recentRunsQuery("30d", { filter: "failed", status: null, day: null }, NOW).status,
    ).toEqual(["failed"]);
    expect(
      recentRunsQuery("30d", { filter: "automations", status: null, day: null }, NOW).kind,
    ).toBe("automation");
    expect(recentRunsQuery("30d", { filter: "chat", status: null, day: null }, NOW).kind).toBe(
      "chat",
    );
    expect(
      recentRunsQuery("30d", { filter: "tasks", status: "done", day: null }, NOW).status,
    ).toEqual(["done"]);
    expect(
      recentRunsQuery("30d", { filter: "tasks", status: null, day: null }, NOW).status,
    ).toEqual(["done", "failed", "cancelled"]);
    // failed implies its status, even beside status=done.
    expect(
      recentRunsQuery("30d", { filter: "failed", status: "done", day: null }, NOW).status,
    ).toEqual(["failed"]);
    // All time has no lower bound; a day filter wins over the period.
    expect(recentRunsQuery("all", none, NOW).since).toBeUndefined();
    expect(
      recentRunsQuery("7d", { filter: "all", status: null, day: "2026-09-01" }, NOW).since,
    ).toMatch(/^2026-08-31T/);
  });

  it("does the rest in the client: task and chat kinds, one calendar day in the time zone", () => {
    const run = (kind: "task" | "chat" | "automation", startedAt: string) => ({ kind, startedAt });
    const tasks = { filter: "tasks", status: "done", day: null } as const;
    expect(matchesRecent(run("task", "2026-10-14T10:00:00Z"), tasks)).toBe(true);
    expect(matchesRecent(run("chat", "2026-10-14T10:00:00Z"), tasks)).toBe(true);
    expect(matchesRecent(run("automation", "2026-10-14T10:00:00Z"), tasks)).toBe(false);
    const day = { filter: "all", status: null, day: "2026-10-14" } as const;
    expect(matchesRecent(run("task", "2026-10-14T23:30:00Z"), day, "UTC")).toBe(true);
    expect(matchesRecent(run("task", "2026-10-14T23:30:00Z"), day, "Asia/Tokyo")).toBe(false);
    expect(matchesRecent(run("task", "2026-10-15T00:30:00Z"), day, "UTC")).toBe(false);
  });

  it("builds the Timeline route and reads a section anchor", () => {
    expect(overviewRunHref("run_1")).toBe("/overview/run/run_1");
    expect(overviewRunHref("run_1", { stepId: "stp 2" })).toBe("/overview/run/run_1?step=stp%202");
    expect(overviewAnchor("/overview#upcoming")).toBe("upcoming");
    expect(overviewAnchor("/overview")).toBeUndefined();
  });
});

describe("old agent routes", () => {
  it("still parse in the sheet, and map to the Overview", () => {
    const to = (route: string) => {
      const parsed = agentSheetRoute(route);
      return parsed === null ? "none" : overviewRedirect(parsed);
    };
    expect(to("/agent/activity")).toBe("/overview#now");
    expect(to("/agent/upcoming")).toBe("/overview#upcoming");
    expect(to("/agent/growth")).toBe("/overview#growth");
    expect(to("/agent/activity/run/run_1")).toBe("/overview/run/run_1");
    expect(to("/agent/activity/run/run_1?step=stp_2")).toBe("/overview/run/run_1?step=stp_2");
    // A task, Approvals and Soul & Memory stay in the sheet.
    expect(to("/agent/activity/task_1")).toBeNull();
    expect(to("/agent/approvals")).toBeNull();
    expect(to("/agent/soul?file=SOUL.md")).toBeNull();
  });
});

describe("upcoming groups", () => {
  const item = (schedule: string, nextRunAt: string): UpcomingItem => ({
    kind: "automation",
    id: schedule,
    title: schedule,
    nextRunAt,
    enabled: true,
    schedule,
  });
  const at = (days: number, hour = 9) =>
    new Date(STORY_NOW + days * 24 * HOUR + hour * 0).toISOString();

  it("reads the cadence of interval and stepped schedules", () => {
    expect(cadenceMs("PT45M")).toBe(45 * 60_000);
    expect(cadenceMs("PT6H")).toBe(6 * HOUR);
    expect(cadenceMs("*/5 * * * *")).toBe(5 * 60_000);
    expect(cadenceMs("0 */2 * * *")).toBe(2 * HOUR);
    expect(cadenceMs("0 7 * * 1-5")).toBeNull();
    expect(isFrequent("PT45M")).toBe(true);
    expect(isFrequent("PT24H")).toBe(false);
    expect(isFrequent("0 9 1 * *")).toBe(false);
  });

  it("counts calendar days in the owner's time zone", () => {
    const evening = Date.parse("2026-10-18T23:30:00Z");
    expect(dayOffset(evening + HOUR, evening, "UTC")).toBe(1);
    // 23:30 UTC is already the next morning in Tokyo, so one hour later is the same day there.
    expect(dayOffset(evening + HOUR, evening, "Asia/Tokyo")).toBe(0);
  });

  it("groups by day and collapses frequent automations into Today", () => {
    const entries = [
      item("PT45M", at(3)),
      item("0 7 * * 1-5", at(0)),
      item("0 8 * * *", at(1)),
      item("0 9 * * 3", at(4)),
      item("0 9 1 * *", at(14)),
    ].map((i) => ({ item: i, automation: undefined }));
    const groups = groupUpcoming(entries, STORY_NOW, "UTC");
    expect(groups.today.map((e) => e.item.schedule)).toEqual(["PT45M", "0 7 * * 1-5"]);
    expect(groups.tomorrow.map((e) => e.item.schedule)).toEqual(["0 8 * * *"]);
    expect(groups.week.map((e) => e.item.schedule)).toEqual(["0 9 * * 3"]);
    expect(groups.later.map((e) => e.item.schedule)).toEqual(["0 9 1 * *"]);
  });
});

function world(props: Omit<StoryWorldProps, "children">, ui: React.ReactNode) {
  const edit = props.edit;
  return render(
    <StoryWorld
      {...props}
      edit={(w) => {
        applyRunTrace(w);
        edit?.(w);
      }}
    >
      {ui}
    </StoryWorld>,
  );
}

describe("Now & next", () => {
  it("lists what is running and opens its Timeline in the Overview", async () => {
    const navigate = vi.fn();
    world({ slots: { navigate } }, <NowSection now={STORY_NOW} />);
    const running = await screen.findByRole("region", { name: "Running now" });
    fireEvent.click(
      within(running).getAllByRole("button", { name: /Dentist booking/ })[0] as HTMLElement,
    );
    expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/overview\/run\//));
    expect(screen.getByRole("heading", { name: "Now & next" })).toBeTruthy();
  });

  it("shows the next scheduled runs", async () => {
    world({}, <NowSection now={STORY_NOW} />);
    const next = await screen.findByRole("region", { name: "Next up" });
    expect(within(next).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(within(next).getAllByRole("listitem").length).toBeLessThanOrEqual(3);
  });
});

describe("Upcoming", () => {
  it("groups by day, with a frequent automation as one row with its cadence", async () => {
    world({}, <UpcomingSection now={STORY_NOW} />);
    const today = await screen.findByTestId("overview-upcoming-today");
    expect(within(today).getByText("Heartbeat")).toBeTruthy();
    expect(within(today).getByText(/every 45 min/i)).toBeTruthy();
    expect(screen.getByTestId("overview-upcoming-later")).toBeTruthy();
    // Each automation appears once.
    expect(screen.getAllByText("Heartbeat")).toHaveLength(1);
  });

  it("keeps paused automations under a disclosure", async () => {
    world(
      {
        edit: (w) => {
          const a = w.automations.find((x) => x.title === "Subscription audit");
          if (a) a.enabled = false;
        },
      },
      <UpcomingSection now={STORY_NOW} />,
    );
    const toggle = await screen.findByRole("button", { name: "Paused (1)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Subscription audit")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Subscription audit")).toBeTruthy();
  });
});

describe("Recent runs", () => {
  it("filters to failed runs through the route, searches by title, and opens the Timeline", async () => {
    const navigate = vi.fn();
    const onNavigate = vi.fn();
    const ui = (route: string) => (
      <StoryWorld slots={{ navigate }} edit={applyRunTrace}>
        <RecentSection period="30d" route={route} onNavigate={onNavigate} now={STORY_NOW} />
      </StoryWorld>
    );
    const { rerender } = render(ui("/overview?period=30d"));
    const list = await screen.findByTestId("overview-recent-list");
    expect(within(list).getByText("Lisbon research")).toBeTruthy();
    expect(within(list).getByText("Subscription audit")).toBeTruthy();

    // A chip writes the filter into the URL (and keeps the period).
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    expect(onNavigate).toHaveBeenCalledWith("/overview?period=30d&filter=failed");

    // The route is the state: with ?filter=failed only the failed run is listed.
    rerender(ui("/overview?period=30d&filter=failed"));
    await waitFor(() => expect(screen.queryByText("Lisbon research")).toBeNull());
    expect(screen.getByRole("button", { name: "Failed" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(await screen.findByRole("button", { name: /Subscription audit/ }));
    expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/overview\/run\//));

    rerender(ui("/overview?period=30d"));
    await screen.findByText("Lisbon research");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "lisbon" } });
    expect(screen.queryByText("Subscription audit")).toBeNull();
    expect(screen.getByText("Lisbon research")).toBeTruthy();
  });

  it("keeps its own filter when there is no router", async () => {
    world({}, <RecentSection period="30d" now={STORY_NOW} />);
    await screen.findByText("Lisbon research");
    fireEvent.click(screen.getByRole("button", { name: "Automations" }));
    await waitFor(() => expect(screen.queryByText("Lisbon research")).toBeNull());
    expect((await screen.findAllByText("Morning brief")).length).toBeGreaterThan(0);
  });

  it("shows the Tasks chip and the day chip a tile or bar links to, and clears the day", async () => {
    const onNavigate = vi.fn();
    world(
      {},
      <RecentSection
        period="30d"
        route="/overview?filter=tasks&status=done&day=2026-10-18"
        onNavigate={onNavigate}
        now={STORY_NOW}
      />,
    );
    expect(await screen.findByRole("button", { name: "Tasks" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /Clear the 2026-10-18 filter/ }));
    expect(onNavigate).toHaveBeenCalledWith("/overview?period=30d&filter=tasks&status=done");
  });

  it("pages by cursor", async () => {
    world(
      {
        edit: (w) => {
          const base = w.runs.find((r) => r.status === "done" && r.kind === "chat");
          if (!base) throw new Error("fixture run missing");
          for (let i = 0; i < 40; i += 1) {
            w.runs.push({
              ...base,
              id: `run_page_${String(i).padStart(2, "0")}`,
              title: `Paged run ${i}`,
              startedAt: new Date(STORY_NOW - (i + 1) * 60_000 - 3 * 24 * HOUR).toISOString(),
              endedAt: new Date(STORY_NOW - i * 60_000 - 3 * 24 * HOUR).toISOString(),
            });
          }
        },
      },
      <RecentSection period="30d" now={STORY_NOW} />,
    );
    const list = await screen.findByTestId("overview-recent-list");
    const before = within(list).getAllByRole("listitem").length;
    expect(before).toBeGreaterThan(20);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("overview-recent-list")).getAllByRole("listitem").length,
      ).toBeGreaterThan(before),
    );
  });
});

describe("the Timeline page", () => {
  it("has a back link named for the persona and the Timeline at full width", async () => {
    const onBack = vi.fn();
    world({}, <OverviewRun runId="run_missing" onBack={onBack} now={STORY_NOW} />);
    const back = screen.getByRole("button", { name: "Wren & you" });
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalled();
    expect(screen.getByTestId("overview-run").getAttribute("data-run-id")).toBe("run_missing");
  });
});
