import type { ApprovalRequest } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { answerFor, cardChoices, inlineChoices } from "../src/blocks/approval-choice.ts";

/** Approvals W1: "for this chat" on a host-command card is the program grant of that chat. */

function execCard(over: Record<string, unknown> = {}, program = true): ApprovalRequest {
  return {
    id: "apr_1",
    kind: "exec_host",
    summary: "Run ls",
    details: program
      ? {
          hostProgram: {
            program: "ls",
            executable: "/bin/ls",
            sha256: `sha256:${"a".repeat(64)}`,
            folder: "/Users/o/work",
            argv: null,
            ...over,
          },
        }
      : {},
    bindingHash: `sha256:${"b".repeat(64)}`,
    grantKey: "k",
    requestedBy: { runId: "run_1", taskId: null, threadId: "thr_1" },
    sideEffect: "destructive",
    surfaces: ["desktop"],
    scopesOffered: ["once", "session", "always"],
    deviceOnly: true,
    requiresAuthentication: false,
    taint: false,
    status: "pending",
    scopeGranted: null,
    decidedBy: null,
    requestedAt: "2026-11-25T10:00:00.000Z",
    expiresAt: "2026-11-25T10:30:00.000Z",
    decidedAt: null,
    grantId: null,
  } as unknown as ApprovalRequest;
}

describe("the chat choice on a host-command card", () => {
  it("is the program grant of the chat, with words that name the program and the folder", () => {
    const { allow, second, more } = cardChoices(execCard(), { site: null });
    const all = [allow, second, ...more];
    const chat = all.find((c) => c?.value === "programSession");
    expect(chat?.label).toContain("ls");
    expect(chat?.label).toContain("/Users/o/work");
    // The generic "this chat" choice would promise the wrong reach: it is not on the card.
    expect(all.some((c) => c?.value === "session")).toBe(false);
    expect(answerFor("programSession")).toEqual({
      scope: "session",
      extras: { hostProgram: true },
    });
    // The first card: the lasting second choice stays "always allow the program".
    expect(second?.value).toBe("program");
  });

  it("comes first on the second card for the same program in this chat", () => {
    const { second, more } = cardChoices(execCard({ sessionFirst: true }), { site: null });
    expect(second?.value).toBe("programSession");
    expect(more.some((c) => c.value === "program")).toBe(true);
  });

  it("is not on a card that offers no program grant, nor in an inbox row", () => {
    const none = cardChoices(execCard({}, false), { site: null });
    expect([none.allow, none.second, ...none.more].some((c) => c?.value === "programSession")).toBe(
      false,
    );
    const inline = inlineChoices(execCard({ sessionFirst: true }));
    expect(inline.all.some((c) => c.value === "programSession" || c.value === "program")).toBe(
      false,
    );
  });

  it("other kinds keep the generic chat choice (control)", () => {
    const card = { ...execCard(), kind: "calendar_write", sideEffect: "write", details: {} };
    const { allow, second, more } = cardChoices(card as ApprovalRequest, { site: null });
    expect([allow, second, ...more].some((c) => c?.value === "session")).toBe(true);
  });
});
