import type { ApprovalRequest } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalDetails } from "../src/blocks/approval-details.tsx";
import { createFixtureWorld } from "../src/fixtures/index.ts";

/** A send card shows every recipient (to, cc and bcc) from the Gateway's `details.params`. */

function sendApproval(params: Record<string, unknown>): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
  if (!base) throw new Error("no pending approval fixture");
  const to = (params.to as string[]).join(",");
  return {
    ...base,
    kind: "send_email",
    sideEffect: "write",
    details: {
      tool: "gmail_send",
      params,
      target: { kind: "recipient", value: to, display: to },
    },
    target: { kind: "recipient", value: to, display: to },
  } as ApprovalRequest;
}

describe("send_email details on a Gateway card", () => {
  it("shows To, Cc, Bcc and Subject from params, with bcc not hidden", () => {
    const { container } = render(
      <ApprovalDetails
        approval={sendApproval({
          to: ["jane@example.com"],
          cc: ["sam@example.com"],
          bcc: ["evil@example.net"],
          subject: "Lunch plans",
          body: "Noon?",
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("jane@example.com");
    expect(text).toContain("sam@example.com");
    expect(text).toContain("evil@example.net");
    expect(text).toContain("Lunch plans");
    expect(screen.getByText("Bcc")).toBeTruthy();
  });

  it("falls back to the top-level keys on an older card", () => {
    const old = {
      ...sendApproval({ to: ["jane@example.com"] }),
      details: { to: ["jane@example.com"], subject: "Old shape" },
    } as ApprovalRequest;
    const { container } = render(<ApprovalDetails approval={old} />);
    expect(container.textContent ?? "").toContain("Old shape");
    expect(container.textContent ?? "").toContain("jane@example.com");
  });

  it("still shows reply fields from params (threadId, inReplyTo), so a reply says so", () => {
    const { container } = render(
      <ApprovalDetails
        approval={sendApproval({
          to: ["jane@example.com"],
          subject: "Re: Lunch",
          body: "Yes",
          threadId: "thread-abc123",
          inReplyTo: "<msg-42@example.com>",
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("thread-abc123");
    expect(text).toContain("<msg-42@example.com>");
  });
});
