import type { ApprovalRequest } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

/** The `messages_send` compose card: exact recipient, editable text, edited text is answered. */

const NOW = Date.parse(FIXTURE_NOW);
const cand = (id: string, label: string, service = "imessage", extra = {}) => ({
  id,
  kind: "handle",
  recipient: id,
  label,
  service,
  weak: service !== "imessage",
  ...extra,
});

function card(candidates: unknown[], over: Partial<ApprovalRequest> = {}, source = "owner") {
  const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
  if (!base) throw new Error("no pending approval fixture");
  const a = {
    ...base,
    kind: "message_send",
    sideEffect: "destructive",
    summary: "Send a message",
    details: {
      channel: "imessage",
      account: "mac",
      recipient: "x",
      compose: {
        channel: "imessage",
        account: "mac",
        candidates,
        text: "line one⏎line two",
        draftSha256: "sha256:x",
        recipientSource: source,
      },
    },
    deviceOnly: true,
    taint: false,
    scopesOffered: ["once"],
    ...over,
  } as ApprovalRequest;
  const onAnswer = vi.fn();
  render(
    <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
      <ApprovalCard
        approval={a}
        persona="Wren"
        canAnswer
        now={NOW}
        armDelayMs={0}
        onAnswer={onAnswer}
      />
    </UiSlotsProvider>,
  );
  return onAnswer;
}

const allow = () => screen.getByRole("button", { name: "Allow with scope" });
const editor = () => screen.getByRole("textbox", { name: /Message text/ });

describe("message_send compose card", () => {
  it("shows the recipient and service, restores line breaks, and answers the edited text", async () => {
    const onAnswer = card([cand("+15550101", "Dana · +15550101")]);
    expect(screen.getByTestId("message-recipient").textContent).toBe("Dana · +15550101");
    expect((editor() as HTMLTextAreaElement).value).toBe("line one\nline two");
    await userEvent.clear(editor());
    await userEvent.type(editor(), "see you at 6");
    await userEvent.click(allow());
    expect(onAnswer).toHaveBeenCalledWith("approve", "once", {
      editedText: "see you at 6",
      recipientChoice: "+15550101",
    });
  });

  it("needs a pick among several candidates, and labels SMS as weak", async () => {
    const onAnswer = card([cand("a", "Mom · +1555"), cand("b", "Mom · +1556", "sms")]);
    expect(screen.getByText(/carrier vouches/)).toBeTruthy();
    await userEvent.click(allow());
    expect(onAnswer).not.toHaveBeenCalled();
    await userEvent.click(screen.getAllByRole("radio")[1] as HTMLElement);
    await userEvent.click(allow());
    expect(onAnswer).toHaveBeenCalledWith("approve", "once", {
      editedText: "line one\nline two",
      recipientChoice: "b",
    });
  });

  it("shows a group with its participants, and warns when the recipient came from untrusted content", () => {
    card(
      [
        cand("chat1", "Climbing crew", "imessage", {
          kind: "chat",
          participants: ["+1555", "+1556"],
        }),
      ],
      { taint: true },
      "untrusted",
    );
    expect(screen.getByText("+1555, +1556")).toBeTruthy();
    expect(screen.getByTestId("message-untrusted")).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Always/ })).toBeNull();
  });

  it("does not allow empty text", async () => {
    const onAnswer = card([cand("+1555", "Dana")]);
    await userEvent.clear(editor());
    await userEvent.click(allow());
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
