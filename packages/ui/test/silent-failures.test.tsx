// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SoulMemoryPanel } from "../src/agent/SoulMemoryPanel.tsx";
import { AutomationChat } from "../src/chat/AutomationChat.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { eveningWrapup } from "../src/fixtures/daily.ts";
import { inboxDigest } from "../src/fixtures/workflows.ts";
import { ProjectsTab } from "../src/memory-page/KindTabs.tsx";
import { PeopleSheetSection } from "../src/people/PeopleSheetSection.tsx";
import { McpCodePanel } from "../src/screens/settings/McpCodePanel.tsx";
import { DailyCard } from "../src/screens/workflows/DailyCard.tsx";
import { DigestCard } from "../src/screens/workflows/DigestCard.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/**
 * Buttons that used to do nothing visible, or failed without a word: each click now shows a
 * result (a row leaves, a notice or toast appears, or an inline error with Retry shows).
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(ui: ReactElement, slots?: Record<string, unknown>) {
  let gateway: MockGateway | undefined;
  const user = userEvent.setup();
  render(
    <StoryWorld
      onGateway={(g) => {
        gateway = g;
      }}
      slots={{ navigate: vi.fn(), ...(slots ?? {}) }}
    >
      {ui}
    </StoryWorld>,
  );
  const gw = () => {
    if (gateway === undefined) throw new Error("gateway not ready");
    return gateway;
  };
  const callsTo = (method: string) => gw().calls.filter((c) => c.method === method);
  return { callsTo, gw, user };
}

describe("DailyCard follow-up buttons", () => {
  it("removes a row once the Gateway took Done", async () => {
    const onFollowup = vi.fn(() => Promise.resolve(true));
    render(<DailyCard brief={eveningWrapup()} onFollowup={onFollowup} />);
    const before = screen.getAllByRole("button", { name: "Done" }).length;
    await userEvent.click(screen.getAllByRole("button", { name: "Done" })[0] as HTMLElement);
    await waitFor(() =>
      expect(screen.queryAllByRole("button", { name: "Done" })).toHaveLength(before - 1),
    );
    expect(onFollowup).toHaveBeenCalledTimes(1);
  });

  it("keeps the row when the Gateway refused the change", async () => {
    const onFollowup = vi.fn(() => Promise.resolve(false));
    render(<DailyCard brief={eveningWrapup()} onFollowup={onFollowup} />);
    const before = screen.getAllByRole("button", { name: "Done" }).length;
    await userEvent.click(screen.getAllByRole("button", { name: "Done" })[0] as HTMLElement);
    await waitFor(() => expect(onFollowup).toHaveBeenCalledTimes(1));
    expect(screen.queryAllByRole("button", { name: "Done" })).toHaveLength(before);
  });

  it("carry-over shows that it is done and hides its button", async () => {
    const onCarryOver = vi.fn(() => Promise.resolve(true));
    render(<DailyCard brief={eveningWrapup()} onCarryOver={onCarryOver} />);
    await userEvent.click(screen.getByRole("button", { name: "Carry over 1 to tomorrow" }));
    expect(await screen.findByText("Carried over.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Carry over 1 to tomorrow" })).toBeNull();
  });
});

describe("DigestCard waiting-on rows", () => {
  it("Done takes the loop off the card once the Gateway took it", async () => {
    const onLoop = vi.fn(() => Promise.resolve(true));
    render(<DigestCard digest={inboxDigest()} now={STORY_NOW} onLoop={onLoop} />);
    const before = screen.getAllByRole("button", { name: "Done" }).length;
    await userEvent.click(screen.getAllByRole("button", { name: "Done" })[0] as HTMLElement);
    await waitFor(() =>
      expect(screen.queryAllByRole("button", { name: "Done" })).toHaveLength(before - 1),
    );
    expect(onLoop).toHaveBeenCalledWith(expect.anything(), "done");
  });
});

describe("Soul & Memory controls", () => {
  it("shows the failure of Pause inline", async () => {
    const { gw, user } = setup(<SoulMemoryPanel />);
    gw().failNext("memory.pause", "conflict", "pause refused");
    await user.click(await screen.findByRole("button", { name: /^Pause$/ }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(gw().calls.filter((c) => c.method === "memory.pause")).toHaveLength(1);
  });

  it("shows the failure of Export inline", async () => {
    const { gw, user } = setup(<SoulMemoryPanel />);
    gw().failNext("memory.export", "conflict", "export refused");
    await user.click(await screen.findByRole("button", { name: /^Export$/ }));
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("keeps the reset dialog open and shows the error when reset fails", async () => {
    const { gw, user } = setup(<SoulMemoryPanel />, { persona: { name: "Ada" } });
    gw().failNext("memory.reset", "conflict", "reset refused");
    await user.click(await screen.findByRole("button", { name: /Ada/ }));
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByRole("textbox"), "reset Ada");
    await user.click(within(dialog).getByRole("button", { name: /^Reset/ }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
});

describe("Automation Run now", () => {
  it("shows a success toast, and an error toast when the run fails", async () => {
    const success = vi.spyOn(toast, "success");
    const error = vi.spyOn(toast, "error");
    const { gw, user } = setup(
      <AutomationChat automationId="aut_1" title="Morning brief" timezone="UTC" now={STORY_NOW} />,
    );
    await user.click(await screen.findByRole("button", { name: "Run now" }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Run started."));

    gw().failNext("automations.run", "conflict", "already running");
    await user.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
  });
});

describe("People sheet suggestions", () => {
  it("Not a project removes the card once answered", async () => {
    const { callsTo, user } = setup(<PeopleSheetSection now={STORY_NOW} />);
    await user.click(await screen.findByRole("radio", { name: "Suggestions" }));
    const card = await screen.findByRole("article", { name: "Is this a project: Backyard fence?" });
    await user.click(within(card).getByRole("button", { name: "Not a project" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Is this a project: Backyard fence?" }),
      ).toBeNull(),
    );
    expect(callsTo("memory.entities.suggestions.answer")[0]?.params).toMatchObject({
      answer: "reject",
    });
  });

  it("keeps the card and reports the error when the answer fails", async () => {
    const error = vi.spyOn(toast, "error");
    const { gw, user } = setup(<PeopleSheetSection now={STORY_NOW} />);
    gw().failNext("memory.entities.suggestions.answer", "conflict", "nope");
    await user.click(await screen.findByRole("radio", { name: "Suggestions" }));
    const card = await screen.findByRole("article", { name: "Is this a project: Backyard fence?" });
    await user.click(within(card).getByRole("button", { name: "Not a project" }));
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("heading", { name: "Is this a project: Backyard fence?" }),
    ).toBeTruthy();
  });
});

describe("Memory projects read failure", () => {
  it("shows an error with Retry instead of the empty state", async () => {
    const { gw, user } = setup(<ProjectsTab now={STORY_NOW} onNavigate={vi.fn()} />);
    gw().failNext("memory.entities.search", "unavailable", "search is down");
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("MCP code panel read failure", () => {
  it("shows the error from mcp.files.read", async () => {
    const server = { id: "mcp_1", name: "docs", version: "1.0.0", runtime: "node", entry: "x" };
    const { gw, user } = setup(<McpCodePanel server={server as never} now={STORY_NOW} />);
    gw().failNext("mcp.files.read", "unavailable", "files unreadable");
    await user.click(await screen.findByRole("button", { name: "View code" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
