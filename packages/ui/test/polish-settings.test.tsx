import type { AutomationRun } from "@psyche/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { SCHEDULED_NOW, SCHEDULED_ZONE } from "../src/fixtures/scheduled.ts";
import { RunHistoryView } from "../src/screens/scheduled/RunHistory.tsx";
import { AboutPanel } from "../src/screens/settings/AboutSection.tsx";
import { StoragePanel, StorageSection } from "../src/screens/settings/StorageSection.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

const iso = (offset: number) => new Date(SCHEDULED_NOW + offset).toISOString();

const run = (over: Partial<AutomationRun>): AutomationRun => ({
  id: "run_1",
  automationId: "auto_1",
  threadId: null,
  taskId: null,
  trigger: "schedule",
  scheduledFor: iso(-120_000),
  coalesced: 1,
  startedAt: iso(-120_000),
  endedAt: null,
  status: "running",
  summary: "529 overloaded",
  notificationId: null,
  runId: null,
  attempt: 1,
  retryAt: iso(60_000),
  ...over,
});

describe("Cancel retry in the run history", () => {
  it("is offered only on a run waiting to retry, and calls back with that run", async () => {
    const onCancelRetry = vi.fn().mockResolvedValue(undefined);
    render(
      <RunHistoryView
        runs={[
          run({}),
          run({ id: "run_2", retryAt: null, attempt: 0 }),
          run({ id: "run_3", status: "failed", endedAt: iso(-60_000), retryAt: null }),
        ]}
        now={SCHEDULED_NOW}
        timezone={SCHEDULED_ZONE}
        onCancelRetry={onCancelRetry}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: /Cancel the retry/ });
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0] as HTMLElement);
    expect(onCancelRetry).toHaveBeenCalledWith(expect.objectContaining({ id: "run_1" }));
  });

  it("says so when the Gateway refuses", async () => {
    const onCancelRetry = vi.fn().mockRejectedValue(new Error("this run is not waiting to retry"));
    render(
      <RunHistoryView
        runs={[run({})]}
        now={SCHEDULED_NOW}
        timezone={SCHEDULED_ZONE}
        onCancelRetry={onCancelRetry}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Cancel the retry/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't cancel the retry/);
  });

  it("shows no button without a handler", () => {
    render(<RunHistoryView runs={[run({})]} now={SCHEDULED_NOW} timezone={SCHEDULED_ZONE} />);
    expect(screen.queryByRole("button", { name: /Cancel the retry/ })).toBeNull();
  });
});

describe("Storage", () => {
  it("lists the categories and calls storage.clearCache only after the confirm", async () => {
    let gateway: MockGateway | undefined;
    render(
      <StoryWorld onGateway={(g) => (gateway = g)}>
        <StorageSection />
      </StoryWorld>,
    );
    expect(await screen.findByText("Attachments and Library")).toBeTruthy();
    expect(screen.getByText("Browser profiles")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear…" }));
    // The confirm names what is deleted and what is not; nothing has been called yet.
    expect(screen.getByRole("alertdialog").textContent).toMatch(/aren't touched/);
    expect(gateway?.calls.filter((c) => c.method === "storage.clearCache")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(gateway?.calls.filter((c) => c.method === "storage.clearCache")).toHaveLength(1),
    );
    expect((await screen.findByRole("status")).textContent).toMatch(/freed/);
  });

  it("cancelling the confirm clears nothing", async () => {
    const onClear = vi.fn().mockResolvedValue(0);
    render(
      <StoragePanel
        categories={[
          { id: "database", bytes: 100, clearable: false },
          { id: "caches", bytes: 5000, clearable: true },
        ]}
        totalBytes={5100}
        onClear={onClear}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear…" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("offers no Clear when nothing is clearable, and reports a failed clear", async () => {
    const { unmount } = render(
      <StoragePanel
        categories={[{ id: "database", bytes: 100, clearable: false }]}
        totalBytes={100}
        onClear={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Clear…" })).toBeNull();
    unmount();
    render(
      <StoragePanel
        categories={[{ id: "caches", bytes: 5000, clearable: true }]}
        totalBytes={5000}
        onClear={vi.fn().mockRejectedValue(new Error("busy"))}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear…" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't clear storage/);
  });
});

describe("Release channel", () => {
  it("offers Stable only, with the note, and only on the desktop", () => {
    const { unmount } = render(
      <StoryWorld>
        <AboutPanel info={null} showUpdates />
      </StoryWorld>,
    );
    const select = screen.getByRole("combobox", { name: "Release channel" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Stable"]);
    expect(screen.getByText(/Stable is the only channel for now/)).toBeTruthy();
    unmount();
    render(
      <StoryWorld>
        <AboutPanel info={null} />
      </StoryWorld>,
    );
    expect(screen.queryByRole("combobox", { name: "Release channel" })).toBeNull();
  });
});
