// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MockGateway } from "../../../../packages/ui/src/data/mock-gateway.ts";
import { createFixtureWorld, FIXTURE_NOW } from "../../../../packages/ui/src/fixtures/index.ts";
import { usageSummary } from "../../../../packages/ui/src/fixtures/usage.ts";
import type { GatewayEvent, GatewayStatus } from "../../src/client/index.ts";
import { ONBOARDED_KEY, PsycheApp } from "../../src/compose/PsycheApp.tsx";
import type { ShellCommand, ShellPlatform } from "../../src/shell/platform.ts";

afterEach(cleanup);

const MAIN = {
  id: "01JBXY6Q8Z0000000000000001",
  kind: "main",
  title: "Main chat",
  titleSource: "auto",
  parentThreadId: null,
  forkedFromMessageId: null,
  sessionKey: "owner:main",
  personaOverlay: null,
  permissionMode: "balanced",
  modelRef: null,
  pinned: false,
  archivedAt: null,
  expiresAt: null,
  activeWriterRunId: null,
  createdAt: "2026-10-19T10:00:00.000Z",
  updatedAt: "2026-10-19T10:00:00.000Z",
  lastMessageAt: null,
};

/** A paired web host whose Gateway has finished onboarding and holds one empty main thread. */
function webPlatform() {
  const calls: { method: string; params: unknown }[] = [];
  const status: GatewayStatus = { phase: "paired", health: "ok", attempt: 0 };
  const handlers: Record<string, (p: unknown) => unknown> = {
    "settings.get": () => ({
      settings: { [ONBOARDED_KEY]: "2026-10-19T09:00:00.000Z" },
      stateVersion: 1,
    }),
    "threads.list": () => ({
      threads: [{ thread: MAIN, activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 } }],
      nextCursor: null,
    }),
    "threads.get": () => ({
      thread: MAIN,
      activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
    }),
    "chat.history": () => ({ messages: [], nextCursor: null }),
    "chat.queue.list": () => ({ items: [] }),
    "events.subscribe": () => ({ ok: true }),
    "memory.read": () => ({
      content: '---\nname: "Flash"\ncreature: "moth"\n---\n',
      etag: "e1",
    }),
  };
  const fallback = new MockGateway(createFixtureWorld(), { now: () => FIXTURE_NOW });
  const platform: ShellPlatform = {
    kind: "web",
    gateway: {
      getStatus: async () => status,
      onStatus: () => () => {},
      call: async (method, params) => {
        calls.push({ method, params });
        const h = handlers[method];
        if (h) return h(params);
        // Everything else answers like the kit's mock Gateway (sections read real shapes).
        if (method === "usage.summary") return {};
        try {
          return await fallback.request(method as never, params as never);
        } catch {
          return {};
        }
      },
      onEvent: (_cb: (e: GatewayEvent) => void) => () => {},
      onResync: () => () => {},
    },
    storage: { get: () => null, set: () => {} },
    notify: { show: () => {} },
  };
  return { platform, calls };
}

describe("the agent sheet over the chat (redesign §5.7)", () => {
  it("opens from /agent/<tab> over the mounted chat and closes back to the thread", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/agent/approvals");
    const { platform } = webPlatform();
    render(<PsycheApp platform={platform} />);
    const sheet = await screen.findByTestId("agent-sheet");
    // The chat stays mounted underneath: its composer is still there.
    expect(
      await screen.findByRole("textbox", { name: "Message Flash", hidden: true }),
    ).toBeTruthy();
    // The route picks the tab.
    const approvals = within(sheet).getByRole("tab", { name: /Approvals/ });
    expect(approvals.getAttribute("aria-selected")).toBe("true");
    // Closing (Escape) leaves the route for this thread.
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${MAIN.id}`));
    await waitFor(() => expect(screen.queryByTestId("agent-sheet")).toBeNull());
  });
});

describe("the slim agent sheet (agent-overview-2026 O6)", () => {
  it("opens /agent/approvals?view=decided with Decided recently expanded", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/agent/approvals?view=decided");
    const { platform } = webPlatform();
    render(<PsycheApp platform={platform} />);
    const sheet = await screen.findByTestId("agent-sheet");
    const decided = await within(sheet).findByRole("button", { name: /^Decided recently/ });
    expect(decided.getAttribute("aria-expanded")).toBe("true");
  });

  it("the avatar opens the sheet at Approvals", async () => {
    window.innerWidth = 1280;
    window.localStorage.clear();
    window.history.replaceState(null, "", `/chat/${MAIN.id}`);
    const { platform } = webPlatform();
    render(<PsycheApp platform={platform} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Open Flash/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/agent/approvals"));
  });
});

describe("the Feed's instructions sheet (#614)", () => {
  it("opens /feed/instructions over the feed and closes back to /feed", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/feed/instructions");
    const { platform } = webPlatform();
    render(<PsycheApp platform={platform} />);
    const sheet = await screen.findByTestId("feed-instructions");
    expect(await screen.findByTestId("screen-feed")).toBeTruthy();
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(window.location.pathname).toBe("/feed"));
    await waitFor(() => expect(screen.queryByTestId("feed-instructions")).toBeNull());
  });
});

describe("the agent sheet beside the content (#625)", () => {
  it("sits beside the chat on a wide window: the chat stays usable and Escape there keeps it", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/agent/approvals");
    const { platform } = webPlatform();
    render(<PsycheApp platform={platform} />);
    const sheet = await screen.findByTestId("agent-sheet");
    expect(sheet.getAttribute("data-presentation")).toBe("inline");
    expect(screen.getByTestId("agent-sheet-column").contains(sheet)).toBe(true);
    // Not modal: the composer is reachable (not aria-hidden) and there is no dialog.
    const composer = await screen.findByRole("textbox", { name: "Message Flash" });
    expect(screen.queryByRole("dialog")).toBeNull();
    // Escape in the composer belongs to the composer; Escape in the sheet closes it.
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(window.location.pathname).toBe("/agent/approvals");
    fireEvent.keyDown(within(sheet).getByRole("tab", { name: /Approvals/ }), { key: "Escape" });
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${MAIN.id}`));
    await waitFor(() => expect(screen.queryByTestId("agent-sheet")).toBeNull());
  });

  it("stays the modal overlay when the window is too narrow for both", async () => {
    // 900 px: wider than the compact breakpoint, but 900 − 248 − 400 < 480.
    window.innerWidth = 900;
    window.history.replaceState(null, "", "/agent/approvals");
    const { platform } = webPlatform();
    render(<PsycheApp platform={platform} />);
    const sheet = await screen.findByTestId("agent-sheet");
    expect(sheet.getAttribute("data-presentation")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByTestId("agent-sheet-column")).toBeNull();
  });
});

describe("the agent sheet over the current section (#614)", () => {
  it("the Feed's Schedule opens the Overview's Upcoming, and Approvals still opens the sheet over the feed", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/feed");
    const { platform } = webPlatform();
    render(<PsycheApp platform={platform} />);
    const feed = await screen.findByTestId("screen-feed");
    fireEvent.click(within(feed).getByRole("button", { name: "Schedule" }));
    // Upcoming moved to the Overview (agent-overview-2026 O5): the old route redirects there.
    await screen.findByTestId("screen-overview");
    await waitFor(() => expect(window.location.pathname).toBe("/overview"));
    expect(window.location.hash).toBe("#upcoming");
    expect(screen.queryByTestId("agent-sheet")).toBeNull();
  });
});

describe("old agent routes redirect to the Overview (agent-overview-2026 O5)", () => {
  it.each([
    ["/agent/activity", "/overview", "#now", ""],
    ["/agent/upcoming", "/overview", "#upcoming", ""],
    ["/agent/growth", "/overview", "#growth", ""],
    [
      "/agent/activity/run/01JBXY6Q8Z00000000000000R1?step=stp_1",
      "/overview/run/01JBXY6Q8Z00000000000000R1",
      "",
      "?step=stp_1",
    ],
  ])("%s", async (from, pathname, hash, search) => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", from);
    const { platform } = webPlatform();
    render(<PsycheApp platform={platform} />);
    await waitFor(() => expect(window.location.pathname).toBe(pathname));
    expect(window.location.hash).toBe(hash);
    expect(window.location.search).toBe(search);
    expect(screen.queryByTestId("agent-sheet")).toBeNull();
  });
});

describe("Try it fills the chat composer (#677)", () => {
  it("a prefillComposer command opens the chat with the text in the composer, unsent", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/feed");
    const { platform, calls } = webPlatform();
    let emit: ((c: ShellCommand) => void) | undefined;
    platform.windows = {
      popOutPane: async () => {},
      closeWindow: () => {},
      onCommand: (cb) => {
        emit = cb;
        return () => {};
      },
    };
    render(<PsycheApp platform={platform} />);
    await screen.findByTestId("screen-feed");
    act(() => emit?.({ type: "prefillComposer", text: "What's on my calendar today?" }));
    await waitFor(() => expect(window.location.pathname).toBe("/chat"));
    const composer = (await screen.findByRole("textbox", {
      name: "Message Flash",
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(composer.value).toBe("What's on my calendar today?"));
    expect(calls.some((c) => c.method === "chat.send")).toBe(false);
  });
});

describe("the composed app on the web host (A8)", () => {
  it("renders the kit's chat column with the persona and the phone layout below 720 px", async () => {
    window.innerWidth = 390;
    window.history.replaceState(null, "", "/chat");
    const { platform, calls } = webPlatform();
    render(<PsycheApp platform={platform} />);
    const shell = await screen.findByTestId("shell");
    expect(shell.getAttribute("data-compact")).toBe("true");
    // The kit's composer, addressed to the agent named in IDENTITY.md.
    await screen.findByRole("textbox", { name: "Message Flash" });
    // Accessibility (docs/a11y-audit.md A1–A3): a skip link to the one main landmark, an h1 for
    // the chat, and the Appearance settings applied to the document (reduce motion, theme).
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe(
      "#main",
    );
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Main chat" })).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dataset.reduceMotion).toBeDefined());
    // Bottom tab bar: the five phone tabs, no Search and no Settings in the rail.
    const rail = screen.getByTestId("rail");
    const labels = Array.from(rail.querySelectorAll("button")).map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Chat", "Feed", "Ideas", "Goals", "Library", "Overview"]);
    expect(calls.some((c) => c.method === "settings.get")).toBe(true);
    await act(async () => {
      window.innerWidth = 1280;
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => expect(shell.getAttribute("data-compact")).toBe("false"));
  });

  it("shows usage under the persona in the sidebar footer (#599)", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/feed");
    const { platform } = webPlatform();
    const call = platform.gateway.call;
    const asked: unknown[] = [];
    platform.gateway.call = async (method, params, options) => {
      if (method !== "usage.summary") return call(method, params, options);
      asked.push(params);
      return usageSummary();
    };
    render(<PsycheApp platform={platform} />);
    const footer = await screen.findByTestId("usage-footer");
    expect(footer.textContent).toContain("$0.42 today · 18k tokens");
    expect(screen.getByTestId("sidebar-footer").textContent).toContain("Flash");
    expect(asked[0]).toMatchObject({ days: 7 });
  });

  it("shows no usage line when the Gateway can't answer usage.summary", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/feed");
    const { platform } = webPlatform();
    render(<PsycheApp platform={platform} />);
    await screen.findByTestId("sidebar-footer");
    expect(screen.queryByTestId("usage-footer")).toBeNull();
  });

  it("gates on onboarding when the Gateway has no completedAt", async () => {
    const { platform } = webPlatform();
    const call = platform.gateway.call;
    platform.gateway.call = async (method, params, options) =>
      method === "settings.get" ? { settings: {}, stateVersion: 1 } : call(method, params, options);
    render(<PsycheApp platform={platform} />);
    await screen.findByTestId("onboarding");
    // The web can't ask macOS: no Permissions step (#554).
    // The flow loads on demand.
    const progress = await screen.findByRole("navigation", { name: "Onboarding progress" });
    expect(progress.textContent).not.toContain("Permissions");
  });

  it("gives the kit the shell's navigation: Add a goal creates it and opens it (#554)", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/goals");
    const { platform } = webPlatform();
    const call = platform.gateway.call;
    let created: unknown;
    platform.gateway.call = async (method, params, options) => {
      if (method !== "goals.create") return call(method, params, options);
      created = params;
      return {
        goal: {
          id: "01JBXY6Q8Z00000000000000G1",
          title: (params as { title: string }).title,
          category: (params as { category: string }).category,
          status: "active",
          inferred: false,
          confirmedAt: "2026-10-19T10:00:00.000Z",
          plan: null,
          cadence: null,
          nextCheckinAt: null,
          archivedAt: null,
          createdAt: "2026-10-19T10:00:00.000Z",
          updatedAt: "2026-10-19T10:00:00.000Z",
        },
        taskIds: [],
        milestones: [],
        links: [],
      };
    };
    render(<PsycheApp platform={platform} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a goal" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a goal" });
    fireEvent.change(within(dialog).getByLabelText("Goal"), { target: { value: "Learn to swim" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add a goal" }));
    await waitFor(() => expect(window.location.pathname).toBe("/goals/01JBXY6Q8Z00000000000000G1"));
    expect(created).toEqual({ title: "Learn to swim", category: "other" });
  });
});

describe("the Overview route (agent-overview-2026 §3)", () => {
  it("renders /overview as '{persona} & you' and keeps the period in the URL", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/overview?period=30d");
    const { platform } = webPlatform();
    render(<PsycheApp platform={platform} />);
    const screenEl = await screen.findByTestId("screen-overview");
    expect(within(screenEl).getByRole("heading", { level: 1, name: "Flash & you" })).toBeTruthy();
    const month = within(screenEl).getByRole("radio", { name: "Month" });
    expect(month.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(screenEl).getByRole("radio", { name: "All time" }));
    await waitFor(() => expect(window.location.search).toBe("?period=all"));
    fireEvent.click(within(screenEl).getByRole("radio", { name: "Week" }));
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.location.pathname).toBe("/overview");
  });

  it("routes /overview/run/<id> to the Timeline with a back link to the Overview", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/overview/run/01JBXY6Q8Z00000000000000R1");
    const { platform } = webPlatform();
    render(<PsycheApp platform={platform} />);
    const run = await screen.findByTestId("overview-run");
    expect(run.getAttribute("data-run-id")).toBe("01JBXY6Q8Z00000000000000R1");
    fireEvent.click(within(run).getByRole("button", { name: "Flash & you" }));
    await waitFor(() => expect(window.location.pathname).toBe("/overview"));
    expect(await screen.findByRole("heading", { level: 1, name: "Flash & you" })).toBeTruthy();
  });
});

describe("composer dictation in the kit chat (#690)", () => {
  it("shows the mic and starts dictation from it; Psyche has no spoken voice mode", async () => {
    window.innerWidth = 1280;
    window.history.replaceState(null, "", "/chat");
    const { platform, calls } = webPlatform();
    render(<PsycheApp platform={platform} />);
    const chat = await screen.findByTestId("kit-chat");
    // The composer has the dictation mic and no Voice button: answers are text.
    const mic = await within(chat).findByRole("button", { name: /Dictate/ });
    expect(within(chat).queryByTestId("voice-mode-toggle")).toBeNull();
    // A click toggles dictation: it asks the Gateway (or says why it can't listen).
    await act(async () => {
      fireEvent.pointerDown(mic);
      fireEvent.pointerUp(mic);
    });
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "voice.start") ||
          within(chat).queryByRole("status") !== null,
      ).toBe(true),
    );
  });
});
