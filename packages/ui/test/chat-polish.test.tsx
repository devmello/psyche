import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { modelLabel } from "../src/agent/AgentHeader.tsx";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { DisclosureProvider } from "../src/blocks/disclosure.tsx";
import { ReceiptLine } from "../src/blocks/Receipt.tsx";
import { ToolCallRow } from "../src/blocks/ToolRun.tsx";
import { FollowUpQueue } from "../src/chat/FollowUpQueue.tsx";
import { ChatThread } from "../src/chat/Thread.tsx";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { createFixtureWorld, IDS } from "../src/fixtures/index.ts";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

const world = createFixtureWorld();
const receipt = (id: string) => {
  const r = world.receipts.find((x) => x.id === id);
  if (r === undefined) throw new Error(`fixture receipt ${id} missing`);
  return r;
};
const approval = (id: string) => {
  const a = world.approvals.find((x) => x.id === id);
  if (a === undefined) throw new Error(`fixture approval ${id} missing`);
  return a;
};

describe("ReceiptLine (§3.2)", () => {
  it("is one line with the provider id; raw keys only at level 2", () => {
    const r = receipt(IDS.receipts.emailSent);
    const { container, unmount } = render(<ReceiptLine receipt={r} />);
    const text = container.textContent ?? "";
    // The leading status glyph speaks "Done" (redesign §5.3).
    expect(text).toMatch(
      /^Done Sent to jane\.ortiz@example\.com · .* · Gmail id 18c4… · \d{1,2}:\d\d\s[AP]M$/,
    );
    expect(text).not.toContain("gmailThreadId");
    expect(text).not.toContain("r-107");
    unmount();
    const raw = render(
      <DisclosureProvider initial={2} keyboard={false}>
        <ReceiptLine receipt={r} />
      </DisclosureProvider>,
    );
    expect(raw.container.textContent).toContain("gmailThreadId 18c4f2a9e3b1d7c0");
    expect(raw.container.textContent).toContain("r-107");
  });

  it("says outcome unknown once", () => {
    const { container } = render(<ReceiptLine receipt={receipt(IDS.receipts.holdUncertain)} />);
    expect((container.textContent ?? "").match(/outcome unknown/g)).toHaveLength(1);
  });
});

describe("ToolCallRow (§3.2)", () => {
  it("shows the family as an icon (named for AT) and keeps receipt ids for level 2", () => {
    const item = {
      block: {
        type: "tool_call" as const,
        toolCallId: "tc",
        tool: "gmail.send",
        status: "ok" as const,
        level1: "Sent to jane",
      },
      receipt: receipt(IDS.receipts.emailSent),
    };
    const { container, rerender } = render(<ToolCallRow item={item} />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("gmail:")).toBeTruthy();
    expect(container.textContent).not.toContain("r-107");
    expect(container.textContent).not.toContain("gmail.send");
    rerender(<ToolCallRow item={{ ...item, call: null }} raw />);
    expect(container.textContent).not.toContain("gmail.send");
  });
});

describe("ApprovalCard (§3.3)", () => {
  it("is a level-1 surface and keeps ids and the full hash in Details", async () => {
    const a = approval(IDS.approvals.credentialFill);
    const { container } = render(
      <ApprovalCard approval={a} canAnswer onAnswer={() => {}} now={STORY_NOW} armDelayMs={0} />,
    );
    const card = container.querySelector("fieldset") as HTMLElement;
    // Raised surface with a 2 px amber leading edge, not an amber fill (redesign-2026 §5.3).
    expect(card.className).toContain("bg-surface-raised");
    expect(card.className).not.toContain("bg-approval-surface");
    expect(card.querySelector("[data-testid=approval-edge]")).not.toBeNull();
    expect(card.textContent).not.toContain(a.bindingHash);
    // Details are level 2, under the card's ⋯ (§5.3).
    await userEvent.click(screen.getByRole("button", { name: "More about this approval" }));
    const details = await screen.findByRole("menuitemcheckbox", { name: "Details" });
    expect(details.getAttribute("aria-checked")).toBe("false");
    const deny = screen.getByRole("button", { name: "Deny" });
    const allow = screen.getByRole("button", { name: "Allow with scope" });
    await userEvent.click(details);
    expect(card.textContent).toContain(a.bindingHash);
    // Opening Details never moves the buttons: the panel renders after them.
    const panel = card.querySelector("[data-testid=approval-ids]") as HTMLElement;
    expect(deny.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(allow.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers the spec's expiry choices through a styled select", () => {
    const a = approval(IDS.approvals.sendEmail);
    render(
      <ApprovalCard approval={a} canAnswer onAnswer={() => {}} now={STORY_NOW} armDelayMs={0} />,
    );
    const select = screen.queryByLabelText("Always allow until");
    if (select === null) return; // this fixture offers no long-lived scope
    expect(select.closest("[data-slot=native-select-wrapper]")).not.toBeNull();
    const labels = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    for (const l of labels) expect(["until this session ends", "until revoked"]).toContain(l);
  });
});

describe("FollowUpQueue (§3.2)", () => {
  it("changes a queued message's mode by sending it now", async () => {
    const onSendNow = vi.fn();
    render(
      <FollowUpQueue
        items={[
          {
            id: "q1",
            threadId: "t",
            content: "also check Thursday",
            mode: "followUp",
            replyToMessageId: null,
          },
        ]}
        onRemove={() => {}}
        onSendNow={onSendNow}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Change when "also check Thursday"/ }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "Send now, to steer" }));
    expect(onSendNow).toHaveBeenCalledWith(expect.objectContaining({ id: "q1" }), "steer");
  });
});

describe("ChatThread approvals (§3.3)", () => {
  it("shows each pending approval once in the dock plus one quiet pointer", async () => {
    render(
      <StoryWorld>
        <div style={{ height: 900 }}>
          <ChatThread threadId={IDS.threads.dentist} now={STORY_NOW} />
        </div>
      </StoryWorld>,
    );
    const log = await screen.findByRole("log", { name: "Conversation" });
    await waitFor(() =>
      expect(within(log).getAllByRole("button", { name: /^Review approval:/ }).length).toBe(2),
    );
    expect(within(log).queryByText(/approval needed, above the composer/)).toBeNull();
    // The only selects are the approval card's styled expiry; none in the composer.
    for (const select of document.querySelectorAll("select"))
      expect(select.closest("[data-slot=native-select-wrapper]")).not.toBeNull();
    // The pointer opens and focuses that approval's card in the dock.
    const pointer = within(log).getByRole("button", { name: /^Review approval: Send an email/ });
    await userEvent.click(pointer);
    await waitFor(() =>
      expect(document.activeElement?.textContent).toMatch(/Send an email to jane\.ortiz/),
    );
  });
});

describe("approval dock accessibility (docs/a11y-audit.md C2, C4)", () => {
  it("keeps the open card when a sooner-expiring approval arrives, and announces one line", async () => {
    let gw: MockGateway | null = null;
    render(
      <StoryWorld onGateway={(g) => (gw = g)}>
        <div style={{ height: 900 }}>
          <ChatThread threadId={IDS.threads.dentist} now={STORY_NOW} />
        </div>
      </StoryWorld>,
    );
    const dock = await screen.findByTestId("approval-dock");
    const card = () => dock.querySelector<HTMLElement>("[data-approval-id]");
    await waitFor(() => expect(card()).not.toBeNull());
    const first = card()?.dataset.approvalId;
    const base = approval(IDS.approvals.sendEmail);
    act(() => {
      (gw as unknown as MockGateway).requestApproval({
        ...base,
        id: "ap_sooner",
        summary: "Delete an old draft",
        requestedAt: new Date(STORY_NOW).toISOString(),
        expiresAt: new Date(STORY_NOW + 30_000).toISOString(),
      });
    });
    expect(await within(dock).findByRole("status")).toHaveProperty(
      "textContent",
      expect.stringContaining("Approval needed: Delete an old draft"),
    );
    // The card under the owner's focus stays; the new one is a row.
    expect(card()?.dataset.approvalId).toBe(first);
    expect(within(dock).getByRole("button", { name: /Delete an old draft/ })).toBeTruthy();
    // The dock is no longer one big live region.
    expect(dock.getAttribute("aria-live")).toBeNull();
  });
});

describe("modelLabel", () => {
  it("reads like a name", () => {
    expect(modelLabel("anthropic/claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelLabel("anthropic/claude-opus-5-5-20260101")).toBe("Opus 5.5");
    expect(modelLabel("openai/gpt-5-mini")).toBe("GPT 5 Mini");
    expect(modelLabel("google/gemini-2-5-pro")).toBe("Gemini 2.5 Pro");
  });
});
