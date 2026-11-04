import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  APP_AGENT_TABS,
  APP_LIBRARY_SECTIONS,
  APP_SETTINGS_SECTIONS,
  APP_TOP_LEVEL_ROUTES,
  type Notification,
} from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chatFocusFromRoute } from "../src/chat/focus-request.ts";
import { LEGACY_ROUTES, legacyRedirect } from "../src/home/redirects.ts";
import { InboxRow } from "../src/screens/inbox/InboxScreen.tsx";
import { surfaceGroups } from "../src/screens/search/SearchSurface.tsx";
import { DEFAULT_ACTIONS, paletteMatches } from "../src/shell/CommandPalette.tsx";
import { notificationRoute } from "../src/shell/notification-target.ts";
import { destinationFor, RAIL_ITEMS } from "../src/shell/Rail.tsx";

// Vitest runs in packages/ui; the shell code the screens come from is two levels up.
const read = (rel: string) => readFileSync(resolve(process.cwd(), "../..", rel), "utf8");

/** Every route the sidebar's destinations or the palette open, as written. */
const reachable = new Set<string>([
  ...RAIL_ITEMS.map((i) => i.route),
  ...DEFAULT_ACTIONS.flatMap((a) => (a.route === undefined ? [] : [a.route])),
]);
const base = (route: string) => route.split("?")[0] as string;

describe("every screen is reachable (sidebar or palette)", () => {
  // The routes the shell renders, read from the code so a new screen without an entry fails.
  const rendered = [
    ...read("apps/web/src/compose/PsycheApp.tsx").matchAll(/case "([\w-]+)":/g),
    ...read("apps/web/src/compose/first-run.tsx").matchAll(/page === "([\w-]+)"/g),
  ].map((m) => m[1] as string);

  it("finds the screens the shell renders", () => {
    expect(rendered).toEqual(
      expect.arrayContaining([
        "home",
        "memory",
        "search",
        "scheduled",
        "library",
        "overview",
        "inbox",
      ]),
    );
  });

  it("opens every rendered screen from a sidebar row or a palette action", () => {
    expect(rendered).not.toEqual(expect.arrayContaining(["feed"]));
    for (const screenId of new Set(rendered)) {
      if (!(APP_TOP_LEVEL_ROUTES as readonly string[]).includes(screenId)) continue;
      const hit = [...reachable].some((r) => base(r).split("/")[1] === screenId);
      expect(hit, `/${screenId} has a sidebar row or a palette action`).toBe(true);
    }
  });

  it("opens every top-level route (an old one shows the place it moved to)", () => {
    for (const old of LEGACY_ROUTES) {
      const to = legacyRedirect(`/${old}`) ?? "";
      expect(to, `/${old} moved`).toMatch(old === "people" ? /^\/memory/ : /^\/home/);
    }
    for (const top of APP_TOP_LEVEL_ROUTES) {
      if (LEGACY_ROUTES.includes(top)) continue;
      expect(
        [...reachable].some((r) => base(r).split("/")[1] === top),
        `/${top} is in the sidebar or the palette`,
      ).toBe(true);
    }
  });

  it("opens every Settings section and Library section from the palette", () => {
    for (const id of APP_SETTINGS_SECTIONS)
      expect(reachable, `Settings → ${id}`).toContain(`/settings/${id}`);
    for (const id of APP_LIBRARY_SECTIONS)
      expect(reachable, `Library → ${id}`).toContain(`/library/${id}`);
  });

  it("opens the agent sheet's tabs (Activity lives in the Overview, Upcoming on Home)", () => {
    const moved: Record<string, string> = { activity: "/overview", upcoming: "/home" };
    for (const tab of APP_AGENT_TABS) {
      if (moved[tab]) expect(reachable).toContain(moved[tab]);
      else expect(reachable, `/agent/${tab}`).toContain(`/agent/${tab}`);
    }
  });

  it("opens What can you do?, setup, Scheduled → Runs and Memory → Review", () => {
    for (const r of ["/can-do", "/onboarding", "/scheduled?tab=runs", "/memory/review", "/inbox"])
      expect(reachable, r).toContain(r);
  });

  it("has no duplicate sidebar rows and no dead palette ids", () => {
    const rows = RAIL_ITEMS.map((i) => i.route);
    expect(new Set(rows).size).toBe(rows.length);
    const ids = DEFAULT_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of DEFAULT_ACTIONS) expect(a.route ?? "").toMatch(/^\//);
  });

  it("has four places, all on the sidebar (docs/design/consolidation-2026.md §3)", () => {
    expect(RAIL_ITEMS.map((i) => i.id)).toEqual(["chat", "home", "library", "memory"]);
  });

  it("marks the place a page is reached from", () => {
    expect(destinationFor("/agent/soul")).toBe("chat");
    expect(destinationFor("/agent/approvals")).toBe("chat");
    for (const r of ["/inbox", "/feed", "/ideas", "/goals/g1", "/scheduled?tab=runs", "/overview"])
      expect(destinationFor(r), r).toBe("home");
    expect(destinationFor("/people?entity=e1")).toBe("memory");
    expect(destinationFor("/memory?kind=due")).toBe("memory");
    expect(destinationFor("/agent/soul?entity=e1")).toBe("memory");
    expect(destinationFor("/search")).toBeNull();
    expect(destinationFor("/settings/model")).toBeNull();
  });

  it("gives the numbered shortcuts to distinct main screens", () => {
    const keys = RAIL_ITEMS.flatMap((i) => (i.shortcut?.match(/^⌘\d$/) ? [i.shortcut] : []));
    expect(keys).toEqual(["⌘1", "⌘2", "⌘3", "⌘4"]);
  });
});

describe("the palette search", () => {
  const find = (text: string) =>
    DEFAULT_ACTIONS.filter((a) => paletteMatches(a, text)).map((a) => a.id);

  it("finds a Settings section by its name, in any word order", () => {
    expect(find("voice")).toContain("settings-voice");
    expect(find("voice settings")).toContain("settings-voice");
    expect(find("settings → voice")).toContain("settings-voice");
  });

  it("finds screens by what they hold, not only their name", () => {
    expect(find("notifications")).toContain("inbox");
    expect(find("audit")).toContain("overview");
    expect(find("follow-ups")).toContain("memory-review");
    // The pages Home took in are found by their old names.
    for (const old of ["feed", "ideas", "upcoming", "needs you"])
      expect(find(old), old).toContain("go-home");
    expect(find("automation")).toContain("scheduled");
    expect(find("what can")).toContain("can-do");
    expect(find("runs")).toContain("scheduled-runs");
    expect(find("reports")).toContain("go-library");
  });

  it("finds Work due by anything with a deadline, not only school work (W7)", () => {
    for (const word of [
      "homework",
      "rent",
      "bills",
      "deadline",
      "due",
      "to-do",
      "taxes",
      "renewals",
      "project",
    ])
      expect(find(word), word).toContain("memory-due");
    expect(find("work due")).toContain("memory-due");
  });

  it("opens each Memory tab from the palette", () => {
    const route = (id: string) => DEFAULT_ACTIONS.find((a) => a.id === id)?.route;
    expect(route("memory-people")).toBe("/memory?kind=people");
    expect(route("memory-projects")).toBe("/memory?kind=projects");
    expect(route("memory-due")).toBe("/memory?kind=due");
    expect(route("memory-events")).toBe("/memory?kind=events");
    expect(route("memory-review")).toBe("/memory/review");
    expect(find("contacts")).toContain("memory-people");
    expect(find("calendar")).toContain("memory-events");
  });

  it("adds a to-do or a project from the palette, opening the one-line form", () => {
    const route = (id: string) => DEFAULT_ACTIONS.find((a) => a.id === id)?.route;
    expect(route("memory-add-todo")).toBe("/memory?kind=due&add=1");
    expect(route("memory-add-project")).toBe("/memory?kind=projects&add=1");
    expect(find("add to-do")).toContain("memory-add-todo");
    expect(find("new task")).toContain("memory-add-todo");
    expect(find("add project")).toContain("memory-add-project");
    expect(find("new course")).toContain("memory-add-project");
  });

  it("lists everything for an empty search and nothing for nonsense", () => {
    expect(find("")).toHaveLength(DEFAULT_ACTIONS.length);
    expect(find("zzzz-no-such-screen")).toEqual([]);
  });

  it("shows the matching actions as the first group", () => {
    const groups = surfaceGroups([], DEFAULT_ACTIONS, "memory review");
    const first = groups[0];
    expect(first?.id).toBe("actions");
    expect(first?.items.some((i) => i.kind === "action" && i.action.id === "memory-review")).toBe(
      true,
    );
  });

  it("still ranks the actions first when a search hit also matches", () => {
    for (const text of ["homework", "rent"]) {
      const groups = surfaceGroups([], DEFAULT_ACTIONS, text);
      expect(groups[0]?.id, text).toBe("actions");
      expect(
        groups[0]?.items.some((i) => i.kind === "action" && i.action.id === "memory-due"),
        text,
      ).toBe(true);
    }
  });
});

const n = (over: Partial<Notification>): Notification => ({
  id: "n1",
  kind: "task_done",
  title: "Finished",
  body: "",
  taskId: null,
  approvalId: null,
  route: null,
  actions: [],
  surfaces: ["desktop"],
  delivered: {},
  readAt: null,
  resolvedAt: null,
  createdAt: "2026-11-02T10:00:00.000Z",
  ...over,
});

describe("a notification opens its source", () => {
  const lookup = {
    taskThread: async (id: string) => (id === "t_gone" ? null : "th_task"),
    approvalThread: async (id: string) => (id === "ap_none" ? null : "th_ap"),
  };

  it("keeps a durable link as it is, for each kind", async () => {
    const cases: [Partial<Notification>, string][] = [
      [
        { kind: "approval", approvalId: "ap_1", route: "/chat/th_1?approval=ap_1" },
        "/chat/th_1?approval=ap_1",
      ],
      [{ kind: "input_needed", route: "/chat/th_1?message=m_4" }, "/chat/th_1?message=m_4"],
      [{ kind: "task_done", route: "/chat/th_2" }, "/chat/th_2"],
      [{ kind: "task_failed", route: "/overview/run/run_9" }, "/overview/run/run_9"],
      [{ kind: "task_failed", route: "/scheduled?tab=runs" }, "/scheduled?tab=runs"],
      [{ kind: "proactive", route: "/feed/post_1" }, "/feed/post_1"],
      [{ kind: "briefing", route: "/feed/post_2" }, "/feed/post_2"],
      [{ kind: "specialist_result", route: "/chat/th_3" }, "/chat/th_3"],
      [{ kind: "system", route: "/settings/memory" }, "/settings/memory"],
      [{ kind: "reminder", route: "/goals/g_1" }, "/goals/g_1"],
    ];
    for (const [over, want] of cases)
      expect(await notificationRoute(n(over), lookup), want).toBe(want);
  });

  it("resolves an old task link to the chat that ran it", async () => {
    expect(await notificationRoute(n({ route: "/tasks/t_1", taskId: "t_1" }), lookup)).toBe(
      "/chat/th_task",
    );
    expect(await notificationRoute(n({ route: "/tasks/t_1" }), lookup)).toBe("/chat/th_task");
  });

  it("resolves an old approval link to its card in the chat that asked", async () => {
    const old = n({ kind: "approval", route: "/approvals/ap_7", approvalId: "ap_7" });
    expect(await notificationRoute(old, lookup)).toBe("/chat/th_ap?approval=ap_7");
  });

  it("sends an old automation link to Scheduled → Runs", async () => {
    expect(
      await notificationRoute(n({ kind: "task_failed", route: "/upcoming/au_1" }), lookup),
    ).toBe("/scheduled?tab=runs");
  });

  it("falls back to somewhere that opens when the source is gone", async () => {
    expect(await notificationRoute(n({ route: "/tasks/t_gone", taskId: "t_gone" }), lookup)).toBe(
      "/inbox",
    );
    expect(await notificationRoute(n({ kind: "approval", approvalId: "ap_none" }), lookup)).toBe(
      "/agent/approvals",
    );
    expect(await notificationRoute(n({ kind: "approval" }))).toBe("/agent/approvals");
    expect(await notificationRoute(n({ kind: "briefing" }))).toBe("/inbox");
    const failing = { ...lookup, taskThread: async () => Promise.reject(new Error("offline")) };
    expect(await notificationRoute(n({ taskId: "t_1" }), failing)).toBe("/inbox");
  });

  it("lands a chat link on its message or card", () => {
    expect(chatFocusFromRoute("/chat/th_1?message=m_4")).toEqual({
      threadId: "th_1",
      messageId: "m_4",
      artifactId: null,
    });
    expect(chatFocusFromRoute("/chat/th_1?approval=ap_1")).toEqual({
      threadId: "th_1",
      messageId: null,
      artifactId: null,
      approvalId: "ap_1",
    });
    expect(chatFocusFromRoute("/chat/th_1")).toBeNull();
    expect(chatFocusFromRoute("/feed?message=m")).toBeNull();
  });

  it("opens from a click on the row, its title or its button, not from a click on a control", async () => {
    const onOpen = vi.fn();
    const onMarkRead = vi.fn();
    render(
      <InboxRow
        notification={n({ title: "Report ready", route: "/chat/th_1?message=m_4" })}
        now={Date.parse("2026-11-02T10:05:00.000Z")}
        onOpen={onOpen}
        onMarkRead={onMarkRead}
      />,
    );
    const row = screen.getByTestId("inbox-row");
    await userEvent.click(within(row).getByText("Report ready"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    await userEvent.click(within(row).getByTestId("inbox-row-open"));
    await userEvent.click(within(row).getByRole("button", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledTimes(3);
    // The unread dot only marks the row read.
    await userEvent.click(within(row).getByTitle("Mark read"));
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("does not offer to open a notification that links nowhere", () => {
    render(
      <InboxRow
        notification={n({ kind: "briefing", title: "Hello" })}
        now={Date.now()}
        onOpen={() => {}}
      />,
    );
    expect(screen.queryByTestId("inbox-row-open")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });
});
