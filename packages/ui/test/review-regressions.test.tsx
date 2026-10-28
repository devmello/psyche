import type { Notification } from "@psyche/protocol";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { isSafeLink } from "../src/blocks/Markdown.tsx";
import { createFixtureWorld, IDS } from "../src/fixtures/index.ts";
import { InboxRow } from "../src/screens/inbox/InboxScreen.tsx";
import { STORY_NOW } from "../src/stories/harness.tsx";

const world = createFixtureWorld();
const approval = (id: string) => {
  const a = world.approvals.find((x) => x.id === id);
  if (a === undefined) throw new Error(id);
  return a;
};

describe("Markdown links", () => {
  it("accepts web, mail, anchors and same-origin paths only", () => {
    expect(isSafeLink("https://acme.com/a")).toBe(true);
    expect(isSafeLink("mailto:jane@example.com")).toBe(true);
    expect(isSafeLink("#notes")).toBe(true);
    expect(isSafeLink("/library/documents")).toBe(true);
    expect(isSafeLink("//attacker.example/x")).toBe(false);
    expect(isSafeLink("/\\attacker.example\\share")).toBe(false);
    expect(isSafeLink("javascript:alert(1)")).toBe(false);
    expect(isSafeLink("psyche://settings")).toBe(false);
    expect(isSafeLink("file:///etc/passwd")).toBe(false);
  });
});

describe("ApprovalCard keyboard safety", () => {
  it("never approves on Return or Space on the Allow button", async () => {
    const onAnswer = vi.fn();
    render(
      <ApprovalCard
        approval={approval(IDS.approvals.sendEmail)}
        canAnswer
        onAnswer={onAnswer}
        now={STORY_NOW}
        armDelayMs={0}
      />,
    );
    const allow = screen.getByRole("button", { name: "Allow with scope" });
    allow.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onAnswer).not.toHaveBeenCalled();
    // ⌘Return is the keyboard path.
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onAnswer).toHaveBeenCalledWith("approve", "once", undefined);
  });

  it("re-arms when a stale card becomes answerable again", () => {
    vi.useFakeTimers();
    try {
      const a = approval(IDS.approvals.sendEmail);
      const { rerender } = render(
        <ApprovalCard approval={a} canAnswer stale onAnswer={() => {}} now={STORY_NOW} />,
      );
      rerender(
        <ApprovalCard approval={a} canAnswer stale={false} onAnswer={() => {}} now={STORY_NOW} />,
      );
      const deny = screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement;
      expect(deny.disabled).toBe(true);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(deny.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels the session lifetime and shows argv as separate tokens", () => {
    const exec = approval(IDS.approvals.exec);
    render(
      <ApprovalCard
        approval={{ ...exec, details: { ...exec.details, argv: ["rm", "-rf foo"] } }}
        canAnswer
        onAnswer={() => {}}
        now={STORY_NOW}
        armDelayMs={0}
      />,
    );
    expect(screen.getByLabelText('Arguments: "rm", "-rf foo"')).toBeTruthy();
    expect(screen.getByText('"-rf foo"')).toBeTruthy();
  });
});

describe("Inbox inline approval", () => {
  const note = (approvalId: string): Notification => ({
    id: `n_${approvalId}`,
    kind: "approval",
    title: "Approval",
    body: "",
    taskId: null,
    approvalId,
    route: `/agent/approvals`,
    actions: [],
    surfaces: ["desktop"],
    delivered: {},
    readAt: null,
    resolvedAt: null,
    createdAt: world.approvals[0]?.requestedAt ?? "2026-10-18T10:00:00Z",
  });

  it("never offers inline Approve for a purchase, even without device-only flags", () => {
    const purchase = {
      ...approval(IDS.approvals.purchase),
      deviceOnly: false,
      requiresAuthentication: false,
    };
    render(
      <InboxRow
        notification={note(purchase.id)}
        now={STORY_NOW}
        approval={{ approval: purchase, canAnswer: true, stale: false }}
        onApprove={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Approve once/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Open card" })).toBeTruthy();
  });

  it("arms inline buttons after 400 ms and names the target", () => {
    vi.useFakeTimers();
    try {
      const email = approval(IDS.approvals.sendEmail);
      const onApprove = vi.fn();
      render(
        <InboxRow
          notification={note(email.id)}
          now={STORY_NOW}
          approval={{
            approval: { ...email, deviceOnly: false, requiresAuthentication: false },
            canAnswer: true,
            stale: false,
          }}
          onApprove={onApprove}
          onDeny={() => {}}
        />,
      );
      const approve = screen.getByRole("button", { name: `Approve once: ${email.summary}` });
      fireEvent.click(approve);
      expect(onApprove).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(400);
      });
      fireEvent.click(approve);
      expect(onApprove).toHaveBeenCalledTimes(1);
      expect(
        within(approve.parentElement as HTMLElement).getByRole("button", {
          name: `Deny: ${email.summary}`,
        }),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
