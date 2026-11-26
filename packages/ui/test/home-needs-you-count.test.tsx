import type { ApprovalRequest, Notification } from "@psyche/protocol";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useNeedsYouCount } from "../src/agent/AgentSheet.tsx";
import { useAgentStatus } from "../src/agent/useAgentState.ts";
import { type FixtureWorld, IDS } from "../src/fixtures/index.ts";
import { HomeScreen } from "../src/home/HomeScreen.tsx";
import { ShellMotion } from "../src/shell/motion.tsx";
import { ConnectedSidebar } from "../src/shell/Sidebar.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/**
 * The sidebar badge beside Home and Home's "Needs you" read one source (`useNeedsYou`), and both
 * drop a card the moment it is answered or denied, on this device or another.
 */

let world: FixtureWorld | undefined;
let emit: ((event: string, payload: unknown) => void) | undefined;

/** What the chat header and the inspector tab show, beside Home and the sidebar. */
function Counts() {
  const header = useAgentStatus().needsYou;
  const tab = useNeedsYouCount();
  return <output data-testid="agent-counts">{`${header}/${tab}`}</output>;
}

function mount() {
  render(
    <StoryWorld
      edit={(w) => {
        world = w;
      }}
      onGateway={(g) => {
        emit = (event, payload) =>
          (g as unknown as { emit(e: string, p: unknown): void }).emit(event, payload);
      }}
    >
      <ShellMotion>
        <ConnectedSidebar
          route="/home"
          onNavigate={() => {}}
          activeThreadId={null}
          onOpenThread={() => {}}
          now={STORY_NOW}
        />
        <HomeScreen now={STORY_NOW} />
        <Counts />
      </ShellMotion>
    </StoryWorld>,
  );
}

/** The count beside Home, or 0 when no badge is drawn. */
const badge = () => Number(screen.queryByTestId("sidebar-count-home")?.textContent ?? 0);
const needsYouRows = () =>
  screen.queryByTestId("section-needs-you")?.querySelectorAll("article").length ?? 0;

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe("Home's badge and its Needs you section", () => {
  it("start equal, and both are non-zero (positive control)", async () => {
    mount();
    await waitFor(() => expect(badge()).toBeGreaterThan(0));
    await waitFor(() => expect(needsYouRows()).toBe(badge()));
  });

  it("drop together when the Gateway resolves the notifications", async () => {
    mount();
    await waitFor(() => expect(badge()).toBeGreaterThan(0));
    const open = (world?.notifications ?? []).filter(
      (n: Notification) =>
        (n.kind === "approval" || n.kind === "input_needed") && n.resolvedAt == null,
    );
    expect(open.length).toBeGreaterThan(0);
    act(() => {
      for (const n of open)
        emit?.("notification.resolved", {
          notification: { ...n, resolvedAt: "2026-10-18T10:13:00Z" },
        });
    });
    await waitFor(() => expect(badge()).toBe(0));
    expect(screen.queryByTestId("section-needs-you")).toBeNull();
  });

  it("drop when an approval is denied, even before the notification resolves", async () => {
    mount();
    await waitFor(() => expect(badge()).toBeGreaterThan(0));
    const before = badge();
    const approval = (world?.approvals ?? []).find(
      (a: ApprovalRequest) => a.id === IDS.approvals.sendEmail,
    );
    expect(approval).toBeTruthy();
    act(() => {
      emit?.("approval.updated", {
        approval: { ...approval, status: "denied", decidedAt: "2026-10-18T10:13:00Z" },
      });
    });
    await waitFor(() => expect(badge()).toBe(before - 1));
    await waitFor(() => expect(needsYouRows()).toBe(badge()));
  });
});

describe("one count everywhere", () => {
  it("an approval past its expiry leaves Home and the badge at once, then the header and inspector", async () => {
    mount();
    await waitFor(() => expect(badge()).toBeGreaterThan(0));
    const before = badge();
    // Positive control: rows and badge start in step, and the header and inspector agree.
    await waitFor(() => expect(needsYouRows()).toBe(before));
    const [headerBefore, tabBefore] = (screen.getByTestId("agent-counts").textContent ?? "").split(
      "/",
    );
    expect(headerBefore).toBe(tabBefore);
    const approval = (world?.approvals ?? []).find(
      (a: ApprovalRequest) => a.id === IDS.approvals.sendEmail,
    );
    expect(approval?.status).toBe("pending");
    // The deadline has passed but the Gateway has not said "expired" yet.
    act(() => {
      emit?.("approval.updated", {
        approval: { ...approval, expiresAt: new Date(STORY_NOW - 60_000).toISOString() },
      });
    });
    await waitFor(() => expect(badge()).toBe(before - 1));
    await waitFor(() => expect(needsYouRows()).toBe(badge()));
    // Now it does: every count has dropped the same one.
    act(() => {
      emit?.("approval.updated", {
        approval: { ...approval, status: "expired", decidedAt: "2026-10-18T10:13:00Z" },
      });
    });
    await waitFor(() => {
      const [header, tab] = (screen.getByTestId("agent-counts").textContent ?? "").split("/");
      expect(header).toBe(tab);
      expect(Number(header)).toBe(Number(headerBefore) - 1);
    });
    expect(badge()).toBe(before - 1);
  });

  it("an answered approval leaves every count the same way", async () => {
    mount();
    await waitFor(() => expect(badge()).toBeGreaterThan(0));
    const before = badge();
    const [headerBefore] = (screen.getByTestId("agent-counts").textContent ?? "").split("/");
    const approval = (world?.approvals ?? []).find(
      (a: ApprovalRequest) => a.id === IDS.approvals.sendEmail,
    );
    act(() => {
      emit?.("approval.updated", {
        approval: { ...approval, status: "approved", decidedAt: "2026-10-18T10:13:00Z" },
      });
    });
    await waitFor(() => expect(badge()).toBe(before - 1));
    await waitFor(() => expect(needsYouRows()).toBe(badge()));
    const [header, tab] = (screen.getByTestId("agent-counts").textContent ?? "").split("/");
    expect(header).toBe(tab);
    expect(Number(header)).toBe(Number(headerBefore) - 1);
  });
});

describe("Home with nothing to show", () => {
  it("says what will show up, and says nothing when there is content", async () => {
    mount();
    await waitFor(() => expect(badge()).toBeGreaterThan(0));
    expect(screen.queryByTestId("home-quiet")).toBeNull();
    cleanup();
    render(
      <StoryWorld
        edit={(w) => {
          w.notifications = [];
          w.feed = [];
          w.ideas = [];
        }}
      >
        <HomeScreen now={STORY_NOW} />
      </StoryWorld>,
    );
    expect(await screen.findByTestId("home-quiet")).toBeTruthy();
    expect(screen.getByTestId("home-quiet").textContent).toMatch(/will show up here/);
  });
});
