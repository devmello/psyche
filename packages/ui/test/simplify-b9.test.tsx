import type { ApprovalRequest, ThreadListEntry } from "@psyche/protocol";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { GatewayProvider, GatewayStore } from "../src/data/index.ts";
import { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld } from "../src/fixtures/index.ts";
import { sectionLabel } from "../src/screens/library/library-items.ts";
import { ThreadGroup, ThreadRow } from "../src/shell/ThreadList.tsx";
import { UiSlotsProvider } from "../src/slots.tsx";

/**
 * Desktop simplify B9: plain sidebar rows (S20), approval cards with no live countdown (S35) and
 * plain Library labels (S36). The S10 button is covered in exec-host-card.test.tsx.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("S35: an approval card does not tick", () => {
  const T0 = Date.parse("2026-11-27T15:00:00Z");
  const pending = (expiresAt: string): ApprovalRequest => {
    const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
    if (!base) throw new Error("no pending approval fixture");
    return { ...base, status: "pending", expiresAt };
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ["setInterval", "setTimeout", "clearInterval", "Date"] });
  });

  it("sets no interval, shows a static expiry time, and renders the same after a minute", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const onAnswer = vi.fn();
    render(
      <UiSlotsProvider value={{}}>
        <ApprovalCard
          approval={pending(new Date(T0 + 30 * 60_000).toISOString())}
          canAnswer
          armDelayMs={0}
          onAnswer={onAnswer}
        />
      </UiSlotsProvider>,
    );
    expect(setIntervalSpy).not.toHaveBeenCalled();
    const before = screen.getByText(/Expires at/).textContent;
    expect(before).not.toMatch(/\d+:\d\d:\d\d|expires in/i);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText(/Expires at/).textContent).toBe(before);
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  });

  it("still lapses once when the approval expires (positive control)", () => {
    render(
      <UiSlotsProvider value={{}}>
        <ApprovalCard
          approval={pending(new Date(T0 + 5_000).toISOString())}
          canAnswer
          armDelayMs={0}
          onAnswer={() => {}}
        />
      </UiSlotsProvider>,
    );
    expect(screen.getByText(/Expires at/)).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(screen.getByTestId("approval-expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });
});

describe("S20: sidebar thread rows", () => {
  const NOW = "2026-11-24T10:00:00Z";
  const entry = (id: string, kind: string, title: string): ThreadListEntry =>
    ({
      thread: {
        id,
        kind,
        title,
        titleSource: "auto",
        parentThreadId: null,
        forkedFromMessageId: null,
        sessionKey: `owner:${id}`,
        personaOverlay: null,
        permissionMode: "balanced",
        modelRef: null,
        pinned: false,
        archivedAt: null,
        expiresAt: null,
        userCreated: true,
        lastMessageAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
      activity: { running: 0, awaitingInput: 0, awaitingApproval: 0 },
    }) as ThreadListEntry;

  it("keeps rename, pin and archive in the row menu and drops the developer items", async () => {
    render(
      <ul>
        <ThreadRow
          entry={entry("thr_a", "side", "Trip")}
          active={false}
          now={Date.parse(NOW)}
          onOpen={() => {}}
          onRename={() => {}}
          onPin={() => {}}
          onArchive={() => {}}
        />
      </ul>,
    );
    await userEvent.click(screen.getByRole("button", { name: /More for/ }));
    const names = (await screen.findAllByRole("menuitem")).map((m) => m.textContent);
    expect(names).toEqual(expect.arrayContaining(["Rename", "Pin", "Archive"]));
    expect(names.join("|")).not.toMatch(/limits|Compact/i);
  });

  it("hides subagent threads, and puts New private chat in the + menu", async () => {
    const gateway = new MockGateway(
      { threads: [entry("thr_side", "side", "Trip"), entry("thr_sub", "subagent", "Helper run")] },
      { now: () => NOW, latency: 0 },
    );
    const store = new GatewayStore(gateway, { now: () => NOW });
    const onNew = vi.fn();
    const onPrivate = vi.fn();
    render(
      <GatewayProvider client={gateway} store={store}>
        <ThreadGroup
          activeThreadId={null}
          onOpen={() => {}}
          onNewSideChat={onNew}
          onNewIncognitoChat={onPrivate}
          now={Date.parse(NOW)}
        />
      </GatewayProvider>,
    );
    await screen.findByText("Trip");
    expect(screen.queryByText("Helper run")).toBeNull();
    // One + button; no second always-visible private-chat button.
    expect(screen.queryByRole("button", { name: "New private chat" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    const menu = await screen.findAllByRole("menuitem");
    await userEvent.click(
      within(menu[0]?.parentElement as HTMLElement).getByRole("menuitem", {
        name: "New private chat",
      }),
    );
    await waitFor(() => expect(onPrivate).toHaveBeenCalledTimes(1));
    expect(onNew).not.toHaveBeenCalled();
  });
});

describe("S36: Library labels", () => {
  it("calls the artifacts section 'Made by {persona}', and leaves the others alone", () => {
    expect(sectionLabel({ id: "artifacts", label: "Artifacts" }, "Wren")).toBe("Made by Wren");
    expect(sectionLabel({ id: "documents", label: "Documents" }, "Wren")).toBe("Documents");
  });
});
