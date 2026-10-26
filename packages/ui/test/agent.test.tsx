import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ActivityPanel, outcomeTone } from "../src/agent/ActivityPanel.tsx";
import { AgentHeader } from "../src/agent/AgentHeader.tsx";
import {
  AgentRouteSheet,
  AgentSheet,
  AgentSheetBody,
  type AgentTab,
  agentSheetRoute,
} from "../src/agent/AgentSheet.tsx";
import { ApprovalsPanel } from "../src/agent/ApprovalsPanel.tsx";
import { SoulMemoryPanel } from "../src/agent/SoulMemoryPanel.tsx";
import {
  isReminder,
  scheduleSentence,
  snoozedSchedule,
  UpcomingPanel,
} from "../src/agent/UpcomingPanel.tsx";
import { AVATAR_LOOP_MS, Avatar } from "../src/avatar/Avatar.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { IDS } from "../src/fixtures/index.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

function withGateway() {
  const ref: { gateway?: MockGateway } = {};
  return {
    ref,
    onGateway: (g: MockGateway) => {
      ref.gateway = g;
    },
  };
}

describe("AgentHeader", () => {
  it("shows the derived state as text and opens the sheet", async () => {
    let opened = false;
    render(
      <StoryWorld>
        <AgentHeader onOpenSheet={() => (opened = true)} mode="balanced" />
      </StoryWorld>,
    );
    // The snippet names the current work; what needs you is the counter beside it (§3.1).
    expect(await screen.findByText("Hold the 2:30 slot")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /^\d+ needs? you$/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Open Wren's activity/ }));
    expect(opened).toBe(true);
  });
});

describe("ActivityPanel", () => {
  it("filters, opens a task and pauses it", async () => {
    const { ref, onGateway } = withGateway();
    render(
      <StoryWorld onGateway={onGateway}>
        <ActivityPanel now={STORY_NOW} />
      </StoryWorld>,
    );
    // The Task's row (its summary), not the chat run in the same thread.
    const rows = await screen.findAllByRole("button", { name: /Dentist booking/ });
    const task = rows.find((r) => r.textContent?.includes("Holding the 2:30 slot"));
    if (!task) throw new Error("the dentist task row is missing");
    await userEvent.click(task);
    expect(await screen.findByRole("heading", { name: "Dentist booking" })).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(ref.gateway?.calls.some((c) => c.method === "tasks.pause")).toBe(true),
    );
    expect((await screen.findAllByText(/paused/)).length).toBeGreaterThan(0);
  });
});

describe("ApprovalsPanel", () => {
  it("answers from the queue with the selected scope", async () => {
    const { ref, onGateway } = withGateway();
    render(
      <StoryWorld onGateway={onGateway}>
        <ApprovalsPanel now={STORY_NOW} />
      </StoryWorld>,
    );
    const groups = await screen.findAllByRole("group");
    const card = groups.find((g) => /jane\.ortiz/.test(g.textContent ?? ""));
    if (card === undefined) throw new Error("send_email card not found");
    await userEvent.click(within(card).getByRole("radio", { name: "Allow once" }));
    await waitFor(() =>
      expect(
        within(card).getByRole("button", { name: "Allow with scope" }).hasAttribute("disabled"),
      ).toBe(false),
    );
    await userEvent.click(within(card).getByRole("button", { name: "Allow with scope" }));
    await waitFor(() => {
      const call = ref.gateway?.calls.find((c) => c.method === "approvals.answer");
      expect(call?.params).toMatchObject({
        approvalId: IDS.approvals.sendEmail,
        decision: "approve",
        scope: "once",
      });
    });
  });
});

describe("UpcomingPanel", () => {
  it("states schedules as sentences and runs one now", async () => {
    expect(scheduleSentence({ kind: "cron", schedule: "0 7 * * 1-5" })).toBe("weekdays 7:00 AM");
    expect(scheduleSentence({ kind: "interval", schedule: "PT6H" })).toBe("every 6 h");
    const { ref, onGateway } = withGateway();
    render(
      <StoryWorld onGateway={onGateway}>
        <UpcomingPanel now={STORY_NOW} />
      </StoryWorld>,
    );
    const run = await screen.findAllByRole("button", { name: "Run now" });
    await userEvent.click(run[0] as HTMLElement);
    await waitFor(() =>
      expect(ref.gateway?.calls.some((c) => c.method === "automations.run")).toBe(true),
    );
  });
});

describe("SoulMemoryPanel", () => {
  it("edits and saves a persona file with if-match", async () => {
    const { ref, onGateway } = withGateway();
    render(
      <StoryWorld onGateway={onGateway}>
        <SoulMemoryPanel />
      </StoryWorld>,
    );
    // The files are rows; each opens the editor in a level-3 sheet (redesign §5.7).
    await userEvent.click(await screen.findByRole("button", { name: "Open SOUL.md" }));
    const box = await screen.findByRole("textbox", { name: "SOUL.md contents" });
    await userEvent.type(box, "\n- I keep receipts.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const call = ref.gateway?.calls.find((c) => c.method === "memory.write");
      expect((call?.params as { etag?: string } | undefined)?.etag).toBeTruthy();
    });
    expect(ref.gateway?.world.memoryFiles["SOUL.md"]).toContain("I keep receipts.");
  });

  it("reset needs the typed confirmation", async () => {
    const { ref, onGateway } = withGateway();
    render(
      <StoryWorld onGateway={onGateway}>
        <SoulMemoryPanel />
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /Reset Wren/ }));
    const confirm = await screen.findByRole("button", { name: "Reset" });
    expect(
      confirm.hasAttribute("disabled") || confirm.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    await userEvent.type(screen.getByRole("textbox", { name: "Confirmation" }), "reset Wren");
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(ref.gateway?.calls.some((c) => c.method === "memory.reset")).toBe(true),
    );
  });
});

describe("AgentSheetBody", () => {
  it("shows the avatar, name and status, and the Approvals badge matches Needs you", async () => {
    render(
      <StoryWorld>
        <AgentSheetBody tab="approvals" onTabChange={() => {}} now={STORY_NOW} />
      </StoryWorld>,
    );
    expect(await screen.findByRole("heading", { name: "Wren" })).toBeTruthy();
    const label = await screen.findByRole("heading", { name: /^Needs you \(\d+\)$/ });
    const count = /\((\d+)\)/.exec(label.textContent ?? "")?.[1];
    expect(Number(count)).toBeGreaterThan(0);
    const tab = screen.getByRole("tab", { name: /^Approvals/ });
    expect(tab.textContent).toContain(count);
    for (const name of [/^Deferred/, /^Recent/, /^Standing grants/]) {
      expect(
        within(screen.getByRole("navigation", { name: "Approval sections" })).getByRole("button", {
          name,
        }),
      ).toBeTruthy();
    }
  });
});

describe("Activity outcomes", () => {
  it("map to semantic tones", () => {
    expect(outcomeTone("ok · 12s · r-101")).toBe("success");
    expect(outcomeTone("failed · field disabled")).toBe("danger");
    expect(outcomeTone("outcome unknown · not retried")).toBe("approval");
    expect(outcomeTone("waiting")).toBe("approval");
  });
});

describe("Upcoming reminders", () => {
  it("are one-shots with Snooze and Done", async () => {
    expect(isReminder({ kind: "cron", schedule: "0 17 22 10 *" })).toBe(true);
    expect(isReminder({ kind: "cron", schedule: "0 7 * * 1-5" })).toBe(false);
    expect(scheduleSentence({ kind: "cron", schedule: "0 17 22 10 *" })).toBe("Oct 22 5:00 PM");
    expect(
      snoozedSchedule(
        { kind: "cron", schedule: "0 17 22 10 *", nextRunAt: "2026-10-22T17:00:00Z" },
        3_600_000,
        STORY_NOW,
      ),
    ).toBe("0 18 22 10 *");
    const { ref, onGateway } = withGateway();
    render(
      <StoryWorld onGateway={onGateway}>
        <UpcomingPanel now={STORY_NOW} />
      </StoryWorld>,
    );
    const row = (await screen.findByText("Reminder: call Sam")).closest("li");
    if (row === null) throw new Error("reminder row not found");
    expect(within(row).getByText(/Delivers to .* and Telegram/)).toBeTruthy();
    await userEvent.click(within(row).getByRole("button", { name: "Snooze" }));
    await waitFor(() => {
      const call = ref.gateway?.calls.find((c) => c.method === "automations.update");
      expect(call?.params).toMatchObject({ schedule: "0 18 22 10 *" });
    });
    await userEvent.click(within(row).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(ref.gateway?.calls.some((c) => c.method === "automations.delete")).toBe(true),
    );
  });
});

function SheetHarness() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<AgentTab>("soul");
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open the agent
      </button>
      <AgentSheet
        open={open}
        onOpenChange={setOpen}
        tab={tab}
        onTabChange={setTab}
        now={STORY_NOW}
      />
    </>
  );
}

describe("AgentSheet (#508)", () => {
  it("closes from its × and from Escape, and focus returns to the opener", async () => {
    render(
      <StoryWorld>
        <SheetHarness />
      </StoryWorld>,
    );
    const opener = screen.getByRole("button", { name: "Open the agent" });
    await userEvent.click(opener);
    const sheet = await screen.findByRole("dialog");
    // The persona files are listed as rows (redesign §5.7: SOUL.md, USER.md, …).
    expect(within(sheet).getByRole("button", { name: "Open SOUL.md" })).toBeTruthy();
    await userEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    await userEvent.click(opener);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe("the /agent page (#508)", () => {
  it("closes from × and Escape and opens on the requested file", async () => {
    const onClose = vi.fn();
    render(
      <StoryWorld>
        <AgentSheetBody tab="soul" onTabChange={() => {}} file="USER.md" onClose={onClose} />
      </StoryWorld>,
    );
    // The requested file opens in the editor sheet; Escape closes that sheet first.
    const editor = await screen.findByRole("dialog", { name: "USER.md" });
    expect(await within(editor).findByRole("textbox", { name: "USER.md contents" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("redesign E3", () => {
  it("reads /agent/* routes for the sheet", () => {
    expect(agentSheetRoute("/chat")).toBeNull();
    expect(agentSheetRoute("/agent/upcoming")).toEqual({ tab: "upcoming" });
    expect(agentSheetRoute(`/agent/activity/${IDS.tasks.dentist}`)).toEqual({
      tab: "activity",
      taskId: IDS.tasks.dentist,
    });
    expect(agentSheetRoute("/agent/soul?file=memory%2F2026-10-18.md")).toEqual({
      tab: "soul",
      file: "memory/2026-10-18.md",
    });
  });

  it("stops the avatar's idle loop after 5 s (WCAG 2.2.2)", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<Avatar name="Wren" state="idle" />);
      const avatar = container.querySelector("[data-state]") as HTMLElement;
      expect(avatar.dataset.looping).toBe("true");
      act(() => {
        vi.advanceTimersByTime(AVATAR_LOOP_MS + 10);
      });
      expect(avatar.dataset.looping).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the route's sheet and closes it back to the chat", async () => {
    const onClose = vi.fn();
    render(
      <StoryWorld>
        <AgentRouteSheet route={{ tab: "approvals" }} onTabChange={() => {}} onClose={onClose} />
      </StoryWorld>,
    );
    const sheet = await screen.findByRole("dialog", { name: "Wren" });
    expect(
      within(sheet)
        .getByRole("tab", { name: /^Approvals/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
