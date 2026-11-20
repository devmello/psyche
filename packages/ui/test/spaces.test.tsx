import { APP_TOP_LEVEL_ROUTES, resolveAppRoute } from "@psyche/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useThreads } from "../src/data/index.ts";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { IDS } from "../src/fixtures/index.ts";
import { SPACE_IDS, withSpaces } from "../src/fixtures/spaces.ts";
import { destinationFor, RAIL_ITEMS } from "../src/shell/Rail.tsx";
import { HomeSpacesSection } from "../src/spaces/HomeSpacesSection.tsx";
import { SpacePage } from "../src/spaces/SpacePage.tsx";
import { SpaceComposerChip, SpaceSwitcher } from "../src/spaces/SpaceSwitcher.tsx";
import { SpacesScreen } from "../src/spaces/SpacesScreen.tsx";
import { useSpacePaletteActions } from "../src/spaces/use-space-palette.ts";
import { byRecentActivity, spaceLine } from "../src/spaces/use-spaces.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";
import { dataWidget } from "../src/widgets/fixtures.ts";
import { WidgetBlockView } from "../src/widgets/WidgetBlock.tsx";

/** Spaces (docs/design/spaces-2026.md §7.1), against the MockGateway. */

function setup(ui: ReactElement, edit: (w: FixtureWorld) => void = withSpaces) {
  let gateway: MockGateway | undefined;
  const navigate = vi.fn();
  const user = userEvent.setup();
  render(
    <StoryWorld
      edit={edit}
      onGateway={(g) => {
        gateway = g;
      }}
      slots={{ navigate }}
    >
      {ui}
    </StoryWorld>,
  );
  const gw = () => {
    if (gateway === undefined) throw new Error("gateway not ready");
    return gateway;
  };
  const callsTo = (method: string) => gw().calls.filter((c) => c.method === method);
  return { gw, callsTo, navigate, user };
}

/** Loads the thread list into the store, like the shell does. */
function WithThreads({ children }: { children: ReactNode }): ReactElement {
  useThreads();
  return <>{children}</>;
}

describe("routes", () => {
  it("keeps Spaces off the sidebar and out of the top-level route list", () => {
    expect(RAIL_ITEMS.map((i) => i.id)).not.toContain("spaces");
    expect(APP_TOP_LEVEL_ROUTES as readonly string[]).not.toContain("spaces");
    expect(destinationFor("/spaces")).toBe("home");
    expect(destinationFor("/spaces/spc_kitchen")).toBe("home");
    expect(resolveAppRoute("/spaces/spc_kitchen")).toBe("/spaces/spc_kitchen");
  });
});

describe("Space rows", () => {
  it("makes the second line from counts and the clock, never from text", () => {
    const base = {
      id: "s",
      name: "N",
      description: null,
      icon: null,
      entityId: null,
      private: false,
      sort: 1,
      archivedAt: null,
    };
    const line = spaceLine(
      {
        ...base,
        counts: { chats: 2, trackers: 1, due: 3 },
        lastActivityAt: new Date(STORY_NOW - 3 * 3_600_000).toISOString(),
      },
      STORY_NOW,
    );
    expect(line).toBe("3 items due · 2 chats · Active 3 h ago");
    expect(
      spaceLine({ ...base, counts: { chats: 0, trackers: 0, due: 0 }, lastActivityAt: null }, 0),
    ).toBe("Nothing here yet");
  });

  it("orders by activity, then by the owner's order", () => {
    const mk = (id: string, sort: number, at: string | null) => ({
      id,
      name: id,
      description: null,
      icon: null,
      entityId: null,
      private: false,
      sort,
      archivedAt: null,
      counts: { chats: 0, trackers: 0, due: 0 },
      lastActivityAt: at,
    });
    const ids = byRecentActivity([
      mk("a", 1, null),
      mk("b", 2, "2026-10-01T00:00:00Z"),
      mk("c", 3, "2026-10-05T00:00:00Z"),
      mk("d", 4, null),
    ]).map((s) => s.id);
    expect(ids).toEqual(["c", "b", "a", "d"]);
  });
});

describe("Home Spaces section", () => {
  it("lists the Spaces, leaves a private one off, and opens a row", async () => {
    const onNavigate = vi.fn();
    const { user } = setup(<HomeSpacesSection onNavigate={onNavigate} now={STORY_NOW} />);
    const list = await screen.findByRole("list", { name: "Your Spaces" });
    const rows = within(list).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Open Kitchen remodel",
      "Open Job search",
      "Open MATH 21 (Fall 2026)",
    ]);
    expect(screen.queryByText("Surprise party")).toBeNull();
    expect(screen.getByText("The projects you keep coming back to")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "All Spaces" }));
    expect(onNavigate).toHaveBeenCalledWith("/spaces");
    await user.click(within(list).getByRole("button", { name: "Open Job search" }));
    expect(onNavigate).toHaveBeenLastCalledWith(`/spaces/${SPACE_IDS.jobs}`);
  });

  it("shows at most four", async () => {
    setup(<HomeSpacesSection onNavigate={() => {}} now={STORY_NOW} />, (w) => {
      withSpaces(w);
      const first = w.spaces?.spaces[0];
      if (first === undefined || w.spaces === undefined) throw new Error("no spaces");
      for (let i = 0; i < 4; i++) {
        w.spaces.spaces.push({
          ...first,
          space: { ...first.space, id: `spc_extra_${i}`, name: `Extra ${i}`, sort: 10 + i },
          trackers: [],
        });
      }
    });
    const list = await screen.findByRole("list", { name: "Your Spaces" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
  });

  it("is not drawn when there are no Spaces", async () => {
    const { callsTo } = setup(<HomeSpacesSection onNavigate={() => {}} />, () => {});
    await waitFor(() => expect(callsTo("spaces.list").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("section-spaces")).toBeNull();
  });

  it("makes a Space from the + button and opens it", async () => {
    const onNavigate = vi.fn();
    const { user, callsTo } = setup(<HomeSpacesSection onNavigate={onNavigate} />);
    await user.click(await screen.findByRole("button", { name: "New Space" }));
    await user.type(await screen.findByLabelText("Name"), "Garden");
    await user.click(screen.getByRole("button", { name: "Create Space" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    expect(callsTo("spaces.create")[0]?.params).toMatchObject({ name: "Garden" });
    expect(onNavigate.mock.calls[0]?.[0]).toMatch(/^\/spaces\/spc_/);
  });
});

describe("SpacesScreen", () => {
  it("lists every Space, private ones too, and archived ones at the end", async () => {
    setup(<SpacesScreen onNavigate={() => {}} now={STORY_NOW} />, (w) => {
      withSpaces(w);
      const math = w.spaces?.spaces.find((s) => s.space.id === SPACE_IDS.math);
      if (math) math.space = { ...math.space, archivedAt: "2026-10-01T00:00:00Z" };
    });
    expect(await screen.findByRole("button", { name: "Open Surprise party" })).toBeTruthy();
    const archived = await screen.findByRole("list", { name: "Archived" });
    expect(within(archived).getByRole("button", { name: "Open MATH 21 (Fall 2026)" })).toBeTruthy();
  });

  it("reorders with the move buttons, writing only the rows that changed", async () => {
    const { user, callsTo } = setup(<SpacesScreen onNavigate={() => {}} now={STORY_NOW} />);
    await user.click(await screen.findByRole("button", { name: "Move Job search up" }));
    await waitFor(() => expect(callsTo("spaces.update")).toHaveLength(2));
    const writes = callsTo("spaces.update").map((c) => c.params);
    expect(writes).toContainEqual({ spaceId: SPACE_IDS.jobs, sort: 1 });
    expect(writes).toContainEqual({ spaceId: SPACE_IDS.kitchen, sort: 2 });
    const names = (await screen.findAllByRole("button", { name: /^Open / })).map((b) =>
      b.getAttribute("aria-label"),
    );
    await waitFor(() => expect(names[0]).toBe("Open Job search"));
  });

  it("opens New Space on arrival from the palette and goes to the new page", async () => {
    const onNavigate = vi.fn();
    const { user } = setup(<SpacesScreen onNavigate={onNavigate} startAdding />, () => {});
    await user.type(await screen.findByLabelText("Name"), "Trip");
    await user.click(screen.getByRole("button", { name: "Create Space" }));
    await waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(expect.stringMatching(/^\/spaces\//)),
    );
  });
});

describe("SpacePage", () => {
  const page = (onNavigate = vi.fn()) => (
    <WithThreads>
      <SpacePage spaceId={SPACE_IDS.kitchen} onNavigate={onNavigate} now={STORY_NOW} />
    </WithThreads>
  );

  it("shows the trackers, chats, files and links, and opens the Space on arrival", async () => {
    const { callsTo } = setup(page());
    expect(await screen.findByRole("heading", { level: 1, name: "Kitchen remodel" })).toBeTruthy();
    await waitFor(() => expect(callsTo("spaces.open")).toHaveLength(1));
    const trackers = await screen.findAllByTestId("tracker");
    expect(trackers).toHaveLength(2);
    expect(await screen.findByText("Dentist booking")).toBeTruthy();
    expect(screen.getByText("Lisbon trip")).toBeTruthy();
    expect(screen.getByText("~/Projects/Kitchen")).toBeTruthy();
    expect(screen.getByText("Permit portal")).toBeTruthy();
    // The tracker built from an email is marked untrusted by the host frame.
    expect(await screen.findAllByTestId("widget-untrusted")).toHaveLength(1);
  });

  it("starts a chat in the Space", async () => {
    const onNavigate = vi.fn();
    const { user, callsTo } = setup(page(onNavigate));
    await user.click(await screen.findByRole("button", { name: "New chat here" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    expect(callsTo("threads.newChat")[0]?.params).toEqual({
      kind: "side",
      spaceId: SPACE_IDS.kitchen,
    });
    expect(onNavigate.mock.calls[0]?.[0]).toMatch(/^\/chat\//);
  });

  it("edits the instructions with a count", async () => {
    const { user, callsTo } = setup(page());
    await user.click(await screen.findByRole("button", { name: "More about this Space" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit instructions" }));
    const field = await screen.findByRole("textbox", { name: "Instructions for Kitchen remodel" });
    expect(screen.getByText("70 of 4,000")).toBeTruthy();
    await user.clear(field);
    await user.type(field, "Keep it under $20k.");
    expect(screen.getByText("19 of 4,000")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo("spaces.update")).toHaveLength(1));
    expect(callsTo("spaces.update")[0]?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      instructions: "Keep it under $20k.",
    });
  });

  it("shows what Psyche sees here", async () => {
    const { user } = setup(page());
    await user.click(await screen.findByRole("button", { name: "More about this Space" }));
    await user.click(await screen.findByRole("menuitem", { name: "What Psyche sees here" }));
    expect(await screen.findByText("Space card")).toBeTruthy();
    expect(screen.getByText("70 of 4,000 characters")).toBeTruthy();
  });

  it("adds a tracker from a template, refreshes one and removes one", async () => {
    const { user, callsTo } = setup(page());
    await user.click(await screen.findByRole("button", { name: "Add a tracker" }));
    await user.click(await screen.findByRole("menuitem", { name: "Work due" }));
    await waitFor(() => expect(callsTo("spaces.trackers.add")).toHaveLength(1));
    expect(callsTo("spaces.trackers.add")[0]?.params).toEqual({
      spaceId: SPACE_IDS.kitchen,
      template: "work_due",
    });
    await waitFor(() => expect(screen.getAllByTestId("tracker")).toHaveLength(3));

    // Bound trackers keep their own values; query trackers have Refresh.
    const refresh = await screen.findAllByRole("button", { name: /^Refresh / });
    expect(refresh.length).toBeGreaterThan(0);
    await user.click(refresh[0] as HTMLElement);
    await waitFor(() => expect(callsTo("spaces.trackers.refresh")).toHaveLength(1));

    const remove = await screen.findAllByRole("button", { name: /^Remove .* from this Space$/ });
    await user.click(remove[0] as HTMLElement);
    await waitFor(() => expect(callsTo("spaces.trackers.remove")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId("tracker")).toHaveLength(2));
  });

  it("moves a chat out of the Space and another in", async () => {
    const { user, callsTo } = setup(page());
    await user.click(
      await screen.findByRole("button", { name: "Move Dentist booking out of this Space" }),
    );
    await waitFor(() => expect(callsTo("spaces.threads.move")).toHaveLength(1));
    expect(callsTo("spaces.threads.move")[0]?.params).toEqual({
      threadIds: [IDS.threads.dentist],
      spaceId: null,
    });
    await waitFor(() => expect(screen.queryByText("Dentist booking")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Move a chat in" }));
    await user.click(await screen.findByRole("menuitem", { name: "Dentist booking" }));
    await waitFor(() => expect(callsTo("spaces.threads.move")).toHaveLength(2));
    expect(await screen.findByText("Dentist booking")).toBeTruthy();
  });

  it("archives and deletes", async () => {
    const onNavigate = vi.fn();
    const { user, callsTo } = setup(page(onNavigate));
    await user.click(await screen.findByRole("button", { name: "More about this Space" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByText("Delete Kitchen remodel?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete Space" }));
    await waitFor(() => expect(callsTo("spaces.delete")).toHaveLength(1));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("/spaces"));
  });

  it("says so when the Space is gone", async () => {
    setup(<SpacePage spaceId="spc_nope" onNavigate={() => {}} />);
    expect(await screen.findByText(/did not load|is gone/)).toBeTruthy();
  });
});

describe("Chat header and composer", () => {
  it("switches Space by starting a chat in it", async () => {
    const { user, callsTo, navigate } = setup(
      <WithThreads>
        <SpaceSwitcher threadId={IDS.threads.dentist} />
      </WithThreads>,
    );
    const trigger = await screen.findByRole("button", { name: "Space: Kitchen remodel" });
    await user.click(trigger);
    expect(await screen.findByRole("menuitem", { name: "No Space (main chats)" })).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "Job search" }));
    await waitFor(() => expect(callsTo("threads.newChat")).toHaveLength(1));
    expect(callsTo("threads.newChat")[0]?.params).toEqual({
      kind: "side",
      spaceId: SPACE_IDS.jobs,
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/chat\//)));
  });

  it("moves this chat to another Space", async () => {
    const { user, callsTo } = setup(
      <WithThreads>
        <SpaceSwitcher threadId={IDS.threads.dentist} />
      </WithThreads>,
    );
    await user.click(await screen.findByRole("button", { name: "Space: Kitchen remodel" }));
    await user.click(await screen.findByRole("menuitem", { name: "Move this chat to…" }));
    // The submenu lists the Spaces again: its entries come after the menu's own.
    await waitFor(async () =>
      expect(await screen.findAllByRole("menuitem", { name: "Job search" })).toHaveLength(2),
    );
    const entries = await screen.findAllByRole("menuitem", { name: "Job search" });
    fireEvent.click(entries[1] as HTMLElement);
    await waitFor(() => expect(callsTo("spaces.threads.move")).toHaveLength(1));
    expect(callsTo("spaces.threads.move")[0]?.params).toEqual({
      threadIds: [IDS.threads.dentist],
      spaceId: SPACE_IDS.jobs,
    });
  });

  it("is not drawn for the main chat when there are no Spaces, nor in a private window", async () => {
    const { callsTo } = setup(
      <WithThreads>
        <SpaceSwitcher threadId={IDS.threads.main} />
        <SpaceSwitcher threadId={IDS.threads.incognito} />
      </WithThreads>,
      () => {},
    );
    await waitFor(() => expect(callsTo("spaces.list").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("space-switcher")).toBeNull();
  });

  it("shows the main chat's switcher once a Space exists, without a Move item", async () => {
    const { user } = setup(
      <WithThreads>
        <SpaceSwitcher threadId={IDS.threads.main} />
      </WithThreads>,
    );
    await user.click(await screen.findByRole("button", { name: "Space: No Space" }));
    expect(await screen.findByRole("menuitem", { name: "Kitchen remodel" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Move this chat to…" })).toBeNull();
  });

  it("names the Space on the composer chip, only for a chat in one", async () => {
    const { user, navigate } = setup(
      <WithThreads>
        <SpaceComposerChip threadId={IDS.threads.dentist} />
        <SpaceComposerChip threadId={IDS.threads.main} />
      </WithThreads>,
    );
    const chip = await screen.findByRole("button", {
      name: "This chat is in the Space Kitchen remodel",
    });
    expect(chip.textContent).toBe("In Kitchen remodel");
    expect(screen.getAllByTestId("space-chip")).toHaveLength(1);
    await user.click(chip);
    expect(navigate).toHaveBeenCalledWith(`/spaces/${SPACE_IDS.kitchen}`);
  });
});

describe("Add to Space", () => {
  const withWidget = (w: FixtureWorld) => {
    withSpaces(w);
    w.widgets = w.widgets.map((x) => (x.id === dataWidget.id ? { ...x, spaceId: null } : x));
  };

  it("puts a widget on a Space's shelf from its header", async () => {
    const { user, callsTo } = setup(
      <WidgetBlockView block={{ type: "ui", widgetId: dataWidget.id }} />,
      withWidget,
    );
    await user.click(await screen.findByRole("button", { name: "Add to Space…" }));
    await user.click(await screen.findByRole("menuitem", { name: "Job search" }));
    await waitFor(() => expect(callsTo("spaces.trackers.add")).toHaveLength(1));
    expect(callsTo("spaces.trackers.add")[0]?.params).toEqual({
      spaceId: SPACE_IDS.jobs,
      widgetId: dataWidget.id,
    });
    // Now it is on a shelf, so the button goes.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add to Space…" })).toBeNull());
  });

  it("is not offered for a widget already on a shelf", async () => {
    setup(<WidgetBlockView block={{ type: "ui", widgetId: "wdg_progress" }} />);
    await screen.findByTestId("widget");
    expect(screen.queryByRole("button", { name: "Add to Space…" })).toBeNull();
  });
});

function Actions(): ReactElement {
  const actions = useSpacePaletteActions(true, () => {});
  return (
    <ul>
      {actions.map((a) => (
        <li key={a.id} data-route={a.route ?? ""}>
          {a.label}
        </li>
      ))}
    </ul>
  );
}

describe("⌘K entries", () => {
  it("lists Spaces, New Space, Archived Spaces and a chat entry per Space", async () => {
    setup(<Actions />);
    await screen.findByText("Kitchen remodel");
    const labels = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Spaces",
        "New Space",
        "Archived Spaces",
        "Kitchen remodel",
        "New chat in Kitchen remodel",
        "New chat in Surprise party",
      ]),
    );
    const routeOf = (label: string) =>
      screen.getByText(label).closest("li")?.getAttribute("data-route");
    expect(routeOf("New Space")).toBe("/spaces?new=1");
    expect(routeOf("Archived Spaces")).toBe("/spaces#archived");
    expect(routeOf("Kitchen remodel")).toBe(`/spaces/${SPACE_IDS.kitchen}`);
  });
});
