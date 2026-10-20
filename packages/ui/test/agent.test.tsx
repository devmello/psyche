import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ActivityPanel } from "../src/agent/ActivityPanel.tsx";
import { AgentHeader } from "../src/agent/AgentHeader.tsx";
import { ApprovalsPanel } from "../src/agent/ApprovalsPanel.tsx";
import { SoulMemoryPanel } from "../src/agent/SoulMemoryPanel.tsx";
import { scheduleSentence, UpcomingPanel } from "../src/agent/UpcomingPanel.tsx";
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
    await userEvent.click(await screen.findByRole("button", { name: /Dentist booking/ }));
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
    expect(scheduleSentence({ kind: "cron", schedule: "0 7 * * 1-5" })).toBe("weekdays 07:00");
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
