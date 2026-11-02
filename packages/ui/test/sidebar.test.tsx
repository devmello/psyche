import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDS } from "../src/fixtures/index.ts";
import { AppShell } from "../src/shell/AppShell.tsx";
import { ShellMotion } from "../src/shell/motion.tsx";
import {
  ConnectedSidebar,
  clampSidebarWidth,
  SIDEBAR_WIDTH,
  Sidebar,
  type SidebarMode,
  type SidebarProps,
  SidebarToggle,
  sidebarResize,
} from "../src/shell/Sidebar.tsx";
import { isMac } from "../src/shell/shortcuts.ts";
import { PEEK_CLOSE_DELAY, PEEK_OPEN_DELAY } from "../src/shell/useSidebarPeek.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

function renderSidebar(props: Partial<SidebarProps> = {}) {
  const onNavigate = vi.fn();
  const onOpenThread = vi.fn();
  function Host() {
    const [width, setWidth] = useState(props.width ?? SIDEBAR_WIDTH.default);
    const [mode, setMode] = useState<SidebarMode>(props.mode ?? "full");
    return (
      <Sidebar
        route="/home"
        onNavigate={onNavigate}
        activeThreadId={null}
        onOpenThread={onOpenThread}
        onNewSideChat={() => {}}
        now={STORY_NOW}
        {...props}
        width={width}
        onWidthChange={setWidth}
        mode={mode}
        onModeChange={setMode}
      />
    );
  }
  render(
    <StoryWorld>
      <ShellMotion>
        <Host />
      </ShellMotion>
    </StoryWorld>,
  );
  return { onNavigate, onOpenThread };
}

const destination = (name: string) =>
  within(screen.getByRole("list", { name: "Destinations" })).getByRole("button", {
    name: new RegExp(`^${name}`),
  });

describe("Sidebar (redesign §5.1)", () => {
  it("lists Search and the four places with Home's amber count, and marks the current one", async () => {
    const onOpenSearch = vi.fn();
    renderSidebar({ route: "/scheduled", counts: { home: 2 }, onOpenSearch });
    const nav = screen.getByRole("navigation", { name: "Sidebar" });
    const names = within(within(nav).getByRole("list", { name: "Destinations" }))
      .getAllByRole("button")
      .map((b) => b.getAttribute("data-destination"));
    expect(names).toEqual(["search", "chat", "home", "library", "people"]);
    expect(screen.queryByTestId("sidebar-more")).toBeNull();
    // Scheduled is reached from Home, so Home is current.
    const home = destination("Home");
    expect(home.getAttribute("aria-current")).toBe("page");
    expect(home.getAttribute("aria-label")).toBe("Home, 2 waiting on you");
    expect(screen.getByTestId("sidebar-count-home").className).toContain("bg-approval-surface");
    // The one selection pill sits behind the current row.
    expect(screen.getAllByTestId("sidebar-selection")).toHaveLength(1);
    expect(home.parentElement?.querySelector('[data-testid="sidebar-selection"]')).not.toBeNull();
    expect(nav.style.width).toBe(`${SIDEBAR_WIDTH.default}px`);
    // Search is not a page: the row opens ⌘K.
    await userEvent.click(screen.getByTestId("sidebar-search"));
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it("puts the selection on the open thread inside Chat and keeps Chat marked current", async () => {
    const { onOpenThread } = renderSidebar({
      route: `/chat/${IDS.threads.dentist}`,
      activeThreadId: IDS.threads.dentist,
    });
    const rows = await screen.findAllByTestId("thread-row");
    const current = rows.find((r) => r.getAttribute("aria-current") === "page");
    expect(current).toBeTruthy();
    expect(
      current?.parentElement?.querySelector('[data-testid="sidebar-selection"]'),
    ).not.toBeNull();
    expect(destination("Chat").getAttribute("aria-current")).toBe("true");
    // Main chat first, by name.
    expect(rows[0]?.textContent).toContain("Main chat");
    await userEvent.click(rows[1] as HTMLElement);
    expect(onOpenThread).toHaveBeenCalled();
  });

  it("moves focus between rows with the arrow keys", async () => {
    renderSidebar();
    await screen.findAllByTestId("thread-row");
    destination("Chat").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(destination("Home"));
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(destination("Chat"));
    await userEvent.keyboard("{End}");
    expect(document.activeElement?.getAttribute("data-sidebar-item")).toBe("");
    expect(document.activeElement?.getAttribute("data-destination")).toBeNull();
  });

  it("resizes between 220 and 320 px from the keyboard, and steps down into the rail", async () => {
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: "Sidebar" });
    const edge = screen.getByRole("separator", { name: "Resize the sidebar" });
    expect(edge.getAttribute("aria-valuemin")).toBe("64");
    expect(edge.getAttribute("aria-valuemax")).toBe("320");
    edge.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(edge.getAttribute("aria-valuenow")).toBe("256");
    await userEvent.keyboard("{End}");
    expect(edge.getAttribute("aria-valuenow")).toBe("320");
    // Home is the narrowest: the compact rail (#598); a step outward opens the full sidebar.
    await userEvent.keyboard("{Home}");
    expect(nav.getAttribute("data-mode")).toBe("rail");
    expect(edge.getAttribute("aria-valuenow")).toBe("64");
    await userEvent.keyboard("{ArrowRight}");
    expect(nav.getAttribute("data-mode")).toBe("full");
    expect(edge.getAttribute("aria-valuenow")).toBe("220");
    await userEvent.keyboard("{ArrowLeft}");
    expect(nav.getAttribute("data-mode")).toBe("rail");
    expect(clampSidebarWidth(9999)).toBe(320);
    expect(clampSidebarWidth(Number.NaN)).toBe(248);
  });

  it("snaps a drag below 180 px to the 64 px rail (#598)", () => {
    expect(sidebarResize(179)).toEqual({ mode: "rail", width: 64 });
    expect(sidebarResize(181)).toEqual({ mode: "full", width: 220 });
    expect(sidebarResize(400)).toEqual({ mode: "full", width: 320 });
    expect(sidebarResize(260)).toEqual({ mode: "full", width: 260 });
  });

  it("as the compact rail: named icon destinations, no threads, the avatar opens the menu", async () => {
    const { onNavigate } = renderSidebar({ mode: "rail", counts: { home: 2 }, route: "/ideas" });
    const nav = screen.getByRole("navigation", { name: "Sidebar" });
    expect(nav.style.width).toBe("64px");
    expect(screen.queryByTestId("thread-group")).toBeNull();
    // An old route (/ideas) shows Home, so Home is current.
    const home = destination("Home");
    expect(home.getAttribute("aria-label")).toBe("Home, 2 waiting on you");
    expect(home.getAttribute("aria-current")).toBe("page");
    expect(home.textContent).toBe("");
    await userEvent.click(destination("People"));
    expect(onNavigate).toHaveBeenCalledWith("/people");
    const footer = screen.getByTestId("sidebar-footer");
    await userEvent.click(within(footer).getByRole("button", { name: "Settings and help" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^Settings/ }));
    expect(onNavigate).toHaveBeenCalledWith("/settings/model");
  });

  it("opens Settings, Usage and Help from the gear in the persona footer", async () => {
    const { onNavigate } = renderSidebar();
    const footer = screen.getByTestId("sidebar-footer");
    expect(footer.textContent).toContain("Wren");
    await userEvent.click(within(footer).getByRole("button", { name: "Settings and help" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^Settings/ }));
    expect(onNavigate).toHaveBeenCalledWith("/settings/model");
  });

  it("keeps Home current on /overview (reached from Home) and opens it from the footer avatar", async () => {
    const { onNavigate } = renderSidebar({ route: "/overview?period=30d" });
    expect(destination("Home").getAttribute("aria-current")).toBe("page");
    await userEvent.click(
      within(screen.getByTestId("sidebar-footer")).getByRole("button", { name: "Open Overview" }),
    );
    expect(onNavigate).toHaveBeenCalledWith("/overview");
  });

  it("reveals the thread filter and narrows the rows", async () => {
    renderSidebar();
    const before = (await screen.findAllByTestId("thread-row")).length;
    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    const field = screen.getByRole("searchbox", { name: "Filter threads" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    await userEvent.type(field, "zzzz-no-such-thread");
    expect(screen.queryAllByTestId("thread-row")).toHaveLength(0);
    expect(screen.getByText("No threads match.")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.getAllByTestId("thread-row")).toHaveLength(before);
  });

  it("counts what waits on the owner from the Gateway, beside Home", async () => {
    render(
      <StoryWorld>
        <ShellMotion>
          <ConnectedSidebar
            route="/home"
            onNavigate={() => {}}
            activeThreadId={null}
            onOpenThread={() => {}}
            now={STORY_NOW}
          />
        </ShellMotion>
      </StoryWorld>,
    );
    await waitFor(() =>
      expect(destination("Home").getAttribute("aria-label")).toMatch(/waiting on you$/),
    );
  });
});

describe("the sidebar toggle (#598)", () => {
  function renderToggle(open = true, mode: SidebarMode = "full") {
    const onToggle = vi.fn();
    const onModeChange = vi.fn();
    render(
      <StoryWorld>
        <SidebarToggle open={open} onToggle={onToggle} mode={mode} onModeChange={onModeChange} />
      </StoryWorld>,
    );
    return { onToggle, onModeChange };
  }

  it("hides and shows on click, with ⌘B in its name for assistive tech", async () => {
    const { onToggle, onModeChange } = renderToggle(true);
    const button = screen.getByRole("button", { name: "Hide the sidebar" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Meta+B");
    await userEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("⌥-click switches to the compact rail and shows a hidden sidebar", async () => {
    const { onToggle, onModeChange } = renderToggle(false, "full");
    const button = screen.getByRole("button", { name: "Show the sidebar" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button, { altKey: true });
    expect(onModeChange).toHaveBeenCalledWith("rail");
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("offers full, compact and hidden from its menu", async () => {
    const { onToggle, onModeChange } = renderToggle(true, "full");
    await userEvent.click(screen.getByRole("button", { name: "Sidebar options" }));
    expect(
      (await screen.findByRole("menuitemradio", { name: /^Full sidebar/ })).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Compact sidebar/ }));
    expect(onModeChange).toHaveBeenCalledWith("rail");
    // Picking a state closes the menu (it used to stay open, so the next trigger click closed it
    // and "Hidden" was found only while the menu animated out: the flake). Wait until it is gone.
    const trigger = screen.getByRole("button", { name: "Sidebar options" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /^Hidden/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("AppShell sidebar and compact layout", () => {
  it("⌥⌘B switches between the full sidebar and the rail; the toggle stays when hidden", async () => {
    render(
      <StoryWorld>
        <AppShell route={`/chat/${IDS.threads.dentist}`} onNavigate={() => {}} now={STORY_NOW} />
      </StoryWorld>,
    );
    const nav = await screen.findByRole("navigation", { name: "Sidebar" });
    expect(nav.getAttribute("data-mode")).toBe("full");
    await userEvent.keyboard(
      isMac() ? "{Meta>}{Alt>}b{/Alt}{/Meta}" : "{Control>}{Alt>}b{/Alt}{/Control}",
    );
    await waitFor(() =>
      expect(screen.getByRole("navigation", { name: "Sidebar" }).getAttribute("data-mode")).toBe(
        "rail",
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Hide the sidebar" }));
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Sidebar" })).toBeNull());
    const show = screen.getByRole("button", { name: "Show the sidebar" });
    await userEvent.click(show);
    // It comes back as it was: the rail.
    await waitFor(() =>
      expect(screen.getByRole("navigation", { name: "Sidebar" }).getAttribute("data-mode")).toBe(
        "rail",
      ),
    );
  });

  it("collapses and restores the sidebar with ⌘B", async () => {
    render(
      <StoryWorld>
        <AppShell route={`/chat/${IDS.threads.dentist}`} onNavigate={() => {}} now={STORY_NOW} />
      </StoryWorld>,
    );
    expect(await screen.findByRole("navigation", { name: "Sidebar" })).toBeTruthy();
    await userEvent.keyboard("{Meta>}b{/Meta}{Control>}b{/Control}");
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Sidebar" })).toBeNull());
  });

  it("uses the top bar, the threads drawer and the tab bar when compact", async () => {
    const routes: string[] = [];
    render(
      <StoryWorld>
        <AppShell
          compact
          route={`/chat/${IDS.threads.dentist}`}
          onNavigate={(r) => routes.push(r)}
          now={STORY_NOW}
        />
      </StoryWorld>,
    );
    expect(screen.queryByRole("navigation", { name: "Sidebar" })).toBeNull();
    expect(screen.getByTestId("compact-top-bar")).toBeTruthy();
    const tabs = screen.getByTestId("tab-bar");
    expect(
      within(tabs)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Chat", "Home", "Library", "People"]);
    await userEvent.click(within(tabs).getByRole("button", { name: /^Home/ }));
    expect(routes).toContain("/home");
    await userEvent.click(screen.getByRole("button", { name: "Threads" }));
    const drawer = await screen.findByRole("dialog", { name: "Threads" });
    expect((await within(drawer).findAllByTestId("thread-row")).length).toBeGreaterThan(0);
  });
});

describe("the compact rail expands on hover (peek)", () => {
  afterEach(() => vi.useRealTimers());
  const host = () => screen.getByTestId("sidebar-host");
  const nav = () => screen.getByTestId("sidebar");
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  it("expands over the content after a rest, keeps its slot at 64 px, and folds after the pointer leaves", () => {
    vi.useFakeTimers();
    renderSidebar({ mode: "rail" });
    expect(nav().hasAttribute("data-peek")).toBe(false);
    fireEvent.pointerEnter(host());
    advance(PEEK_OPEN_DELAY - 1);
    expect(nav().hasAttribute("data-peek")).toBe(false);
    advance(1);
    expect(nav().hasAttribute("data-peek")).toBe(true);
    // The host mode is still the rail and its slot didn't grow: the content never shifts.
    expect(nav().getAttribute("data-mode")).toBe("rail");
    expect(host().style.width).toBe("64px");
    expect(nav().style.width).toBe("248px");
    // The full rows are drawn: labels and the thread group, not tooltip-only icons.
    expect(within(nav()).getByText("Library")).toBeTruthy();
    fireEvent.pointerLeave(host());
    advance(PEEK_CLOSE_DELAY - 1);
    expect(nav().hasAttribute("data-peek")).toBe(true);
    advance(1);
    expect(nav().hasAttribute("data-peek")).toBe(false);
    expect(nav().style.width).toBe("64px");
  });

  it("a pass over the rail that leaves before the rest never opens it", () => {
    vi.useFakeTimers();
    renderSidebar({ mode: "rail" });
    fireEvent.pointerEnter(host());
    advance(PEEK_OPEN_DELAY - 50);
    fireEvent.pointerLeave(host());
    advance(1000);
    expect(nav().hasAttribute("data-peek")).toBe(false);
  });

  it("coming back within the grace keeps it open", () => {
    vi.useFakeTimers();
    renderSidebar({ mode: "rail" });
    fireEvent.pointerEnter(host());
    advance(PEEK_OPEN_DELAY);
    fireEvent.pointerLeave(host());
    advance(PEEK_CLOSE_DELAY - 100);
    fireEvent.pointerEnter(host());
    advance(1000);
    expect(nav().hasAttribute("data-peek")).toBe(true);
  });

  it("does not open for a drag (a button held) or for touch", () => {
    vi.useFakeTimers();
    renderSidebar({ mode: "rail" });
    fireEvent.pointerEnter(host(), { buttons: 1 });
    advance(1000);
    expect(nav().hasAttribute("data-peek")).toBe(false);
    fireEvent.pointerLeave(host());
    fireEvent.pointerEnter(host(), { pointerType: "touch" });
    advance(1000);
    expect(nav().hasAttribute("data-peek")).toBe(false);
  });

  it("a press cancels the pending open: click-to-pin and clicks don't fight the hover", () => {
    vi.useFakeTimers();
    renderSidebar({ mode: "rail" });
    fireEvent.pointerEnter(host());
    advance(100);
    fireEvent.pointerDown(host());
    advance(1000);
    expect(nav().hasAttribute("data-peek")).toBe(false);
    // Leaving and coming back is a new rest.
    fireEvent.pointerLeave(host());
    fireEvent.pointerEnter(host());
    advance(PEEK_OPEN_DELAY);
    expect(nav().hasAttribute("data-peek")).toBe(true);
  });

  it("Escape folds it, and pinning it open (the full sidebar) ends the peek", () => {
    vi.useFakeTimers();
    renderSidebar({ mode: "rail" });
    fireEvent.pointerEnter(host());
    advance(PEEK_OPEN_DELAY);
    fireEvent.keyDown(within(nav()).getByText("Library"), { key: "Escape" });
    expect(nav().hasAttribute("data-peek")).toBe(false);
  });

  it("a full sidebar never peeks, and neither does a rail with hoverExpand off", () => {
    vi.useFakeTimers();
    renderSidebar({ mode: "full" });
    fireEvent.pointerEnter(host());
    advance(1000);
    expect(nav().hasAttribute("data-peek")).toBe(false);
  });

  it("does not expand with hoverExpand off", () => {
    vi.useFakeTimers();
    renderSidebar({ mode: "rail", hoverExpand: false });
    fireEvent.pointerEnter(host());
    advance(1000);
    expect(nav().hasAttribute("data-peek")).toBe(false);
  });

  it("expands for keyboard focus at once and keeps the focused row", async () => {
    const user = userEvent.setup();
    renderSidebar({ mode: "rail" });
    await user.tab();
    await waitFor(() => expect(nav().hasAttribute("data-peek")).toBe(true));
    // The focused destination is still focused after the rail's button became the full row.
    expect(document.activeElement?.getAttribute("data-destination")).toBeTruthy();
    expect(nav().contains(document.activeElement)).toBe(true);
  });

  it("holds while a menu opened from the sidebar is open", async () => {
    const user = userEvent.setup();
    renderSidebar({ mode: "rail" });
    fireEvent.pointerEnter(host());
    await waitFor(() => expect(nav().hasAttribute("data-peek")).toBe(true), { timeout: 1000 });
    await user.click(screen.getByRole("button", { name: "Settings and help" }));
    fireEvent.pointerLeave(host());
    await new Promise((r) => setTimeout(r, PEEK_CLOSE_DELAY * 2 + 50));
    expect(nav().hasAttribute("data-peek")).toBe(true);
  });
});
