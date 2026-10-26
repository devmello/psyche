import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { agentSheetHref, agentSheetRoute } from "../src/agent/AgentSheet.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import type { FixtureWorld } from "../src/fixtures/index.ts";
import { FeedScreen } from "../src/screens/feed/FeedScreen.tsx";
import {
  FEED_INSTRUCTIONS_PATH,
  INTERESTS_PATH,
  parseInterests,
  serializeInterests,
} from "../src/screens/feed/interests.ts";
import { StoryWorld } from "../src/stories/harness.tsx";

function setup(
  ui: ReactElement,
  edit?: (w: FixtureWorld) => void,
  onGateway?: (g: MockGateway) => void,
) {
  let gateway: MockGateway | undefined;
  const navigate = vi.fn();
  const user = userEvent.setup();
  render(
    <StoryWorld
      {...(edit ? { edit } : {})}
      onGateway={(g) => {
        gateway = g;
        onGateway?.(g);
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

describe("interests.md rows (issue #614)", () => {
  const text = `<!-- topic (0.50) — why -->
# Interests
- robotics (0.90) — asked often
- Lisbon (0.6)
Notes the owner wrote.
- !exclude: celebrity news — dismissed 4 posts
`;

  it("keeps lines it doesn't understand, edits rows in place and appends new ones", () => {
    const ledger = parseInterests(text);
    expect(ledger.rows.map((r) => r.kind)).toEqual(["topic", "topic", "exclude"]);
    const rows = ledger.rows.map((r, i) => ({ ...r, origin: i }));
    const [robotics, , exclude] = rows;
    if (robotics?.kind !== "topic" || exclude === undefined) throw new Error("fixture");
    const next = serializeInterests(ledger, [
      { ...robotics, weight: 0.3 },
      exclude,
      { kind: "topic", topic: "urban gardening", weight: 0.6, why: "" },
      { kind: "topic", topic: "  ", weight: 0.6, why: "" },
    ]);
    expect(next).toBe(`<!-- topic (0.50) — why -->
# Interests
- robotics (0.30) — asked often
Notes the owner wrote.
- !exclude: celebrity news — dismissed 4 posts

- urban gardening (0.60)
`);
  });
});

describe("the Feed instructions sheet (issue #614)", () => {
  it("opens from the toolbar, saves the text and the interests, and generates now", async () => {
    const { user, callsTo, gw, navigate } = setup(<FeedScreen />);
    await user.click(await screen.findByRole("button", { name: "What should I write about" }));
    expect(navigate).toHaveBeenCalledWith("/feed/instructions");
    const sheet = await screen.findByRole("dialog", { name: "What should I write about" });
    const text = await within(sheet).findByRole("textbox", {
      name: "What should the feed write about?",
    });
    await user.type(text, "Favour primary sources.");
    await user.selectOptions(
      within(sheet).getByRole("combobox", { name: "How much Lisbon steers the feed" }),
      "0.3",
    );
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo("memory.write")).toHaveLength(2));
    const writes = callsTo("memory.write").map(
      (c) => c.params as { path: string; content: string; etag?: string },
    );
    const instructions = writes.find((w) => w.path === FEED_INSTRUCTIONS_PATH);
    // A new file: no etag; the existing ledger is written with its etag (if-match).
    expect(instructions).toMatchObject({ content: "Favour primary sources.\n" });
    expect(instructions?.etag).toBeUndefined();
    const ledger = writes.find((w) => w.path === INTERESTS_PATH);
    expect(ledger?.etag).toBeTruthy();
    expect(gw().world.memoryFiles[INTERESTS_PATH]).toContain("- Lisbon (0.30)");
    expect(gw().world.memoryFiles[INTERESTS_PATH]).toContain("- !exclude: celebrity news");

    await user.click(within(sheet).getByRole("button", { name: "Generate now" }));
    await waitFor(() => expect(callsTo("feed.generate")).toHaveLength(1));
  });

  it("closes back to /feed when the route opened it", async () => {
    const onClose = vi.fn();
    const { user } = setup(<FeedScreen instructionsOpen onCloseInstructions={onClose} />);
    await screen.findByRole("dialog", { name: "What should I write about" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("reads a missing ledger as empty", async () => {
    setup(<FeedScreen instructionsOpen onCloseInstructions={() => {}} />, (w) => {
      delete w.memoryFiles[INTERESTS_PATH];
    });
    expect(await screen.findByText("No interests yet.")).toBeTruthy();
  });

  it("says what failed when a file can't be read, and saves nothing", async () => {
    const { callsTo } = setup(
      <FeedScreen instructionsOpen onCloseInstructions={() => {}} />,
      undefined,
      (g) => g.failNext("memory.read", "unavailable"),
    );
    expect(await screen.findByText(/Psyche couldn't load the feed instructions/)).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(callsTo("memory.write")).toHaveLength(0);
  });
});

describe("Schedule over the Feed (issue #614)", () => {
  it("opens the agent sheet's Upcoming tab and closes back to /feed", async () => {
    const { user, navigate } = setup(<FeedScreen />);
    await user.click(await screen.findByRole("button", { name: "Schedule" }));
    expect(navigate).toHaveBeenCalledWith("/agent/upcoming?from=%2Ffeed");
    expect(agentSheetRoute("/agent/upcoming?from=%2Ffeed")).toEqual({
      tab: "upcoming",
      back: "/feed",
    });
    // Only same-app paths come back from the route.
    expect(agentSheetRoute("/agent/upcoming?from=%2F%2Fevil.example")).toEqual({ tab: "upcoming" });
    expect(agentSheetRoute("/agent/upcoming?from=https%3A%2F%2Fevil.example")).toEqual({
      tab: "upcoming",
    });
    expect(agentSheetHref("approvals", { back: "/feed" })).toBe("/agent/approvals?from=%2Ffeed");
  });
});
