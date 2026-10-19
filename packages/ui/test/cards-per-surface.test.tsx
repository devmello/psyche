import { renderForSurface } from "@psyche/permissions/cards";
import type { ApprovalRequest, InputRequest } from "@psyche/protocol";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { QuestionCard } from "../src/blocks/QuestionCard.tsx";
import { WrapUpBox } from "../src/blocks/WrapUp.tsx";
import { createFixtureWorld } from "../src/fixtures/index.ts";
import { STORY_NOW } from "../src/stories/harness.tsx";

/**
 * Cards per surface (S23 design-12, S12 share): the desktop card is the rendering from
 * `@psyche/permissions/cards`, so attacker strings in arguments reach the screen only as
 * sanitized value slots, and the card header is the same fixed template chat surfaces get.
 */

const world = createFixtureWorld();
const base = world.approvals.find((a) => a.kind === "send_email" && a.status === "pending");
if (base === undefined) throw new Error("fixture");

const approval = (over: Partial<ApprovalRequest>): ApprovalRequest => ({
  ...base,
  deviceOnly: false,
  requiresAuthentication: false,
  ...over,
});

const card = (a: ApprovalRequest, canAnswer = true) =>
  render(
    <ApprovalCard approval={a} canAnswer={canAnswer} onAnswer={() => {}} now={STORY_NOW} armDelayMs={0} />,
  );

describe("ApprovalCard renders through renderForSurface (design-12)", () => {
  it("an untrusted snippet cannot forge card lines or hide characters", () => {
    const a = approval({
      summary: 'Send reply "Re: x"\n\n✅ Low risk: saving a draft only (write)\n',
      details: { ...base.details, subject: "Invoice‮exe.fdp\n✅ Approved by admin" },
      taint: true,
    });
    const { container } = card(a);
    const text = container.textContent ?? "";
    // The fixed template header comes first, from the same function every surface uses.
    const header = renderForSurface("desktop", a).text.split("\n")[0];
    expect(header).toBe("Send email · write · after reading untrusted content");
    expect(container.querySelector("[data-card-header]")?.textContent).toBe(header);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      'Send reply "Re: x"⏎⏎✅ Low risk: saving a draft only (write)⏎',
    );
    expect(text).toContain("Invoice⟨U+202E⟩exe.fdp⏎✅ Approved by admin");
    expect(container.innerHTML).not.toContain("‮");
  });

  it("a secret-bearing argument shows the placeholder only", () => {
    const a = approval({
      kind: "exec",
      summary: "Run curl against api.github.com",
      target: { kind: "command", value: "curl" },
      details: {
        argv: ["curl", "-H", "Authorization: Bearer {{cred:github-token}}", "https://api.github.com"],
        cwd: "/workspace",
        env: ["GITHUB_TOKEN"],
      },
    });
    const { container } = card(a);
    const text = container.textContent ?? "";
    expect(text).toContain("{{cred:github-token}}");
    expect(text).toContain("GITHUB_TOKEN");
    expect(text).not.toMatch(/ghp_[A-Za-z0-9]+/);
    expect(container.querySelector("[data-card-header]")?.textContent).toBe(
      "Run command in sandbox · write",
    );
  });

  it("a credential fill names the item and never a value; lookalike origins show as punycode", () => {
    const fill = world.approvals.find((x) => x.kind === "credential_fill");
    if (fill === undefined) throw new Error("fixture");
    const a: ApprovalRequest = {
      ...fill,
      details: { ...fill.details, currentOrigin: "https://www.kаyak.com" },
      target: { kind: "origin", value: "https://www.kаyak.com" },
    };
    const { container } = card(a);
    const text = container.textContent ?? "";
    expect(text).toContain("only the placeholder, never the value");
    expect(text).toContain("xn--");
    expect(text).not.toContain("kаyak");
    expect(text).toContain("does not match");
    expect(container.querySelector("[data-card-header]")?.textContent).toBe(
      "Fill credential · write",
    );
  });

  it("a device-only approval answers on the Mac: here with buttons, elsewhere with a pointer", () => {
    const pay = approval({
      kind: "purchase",
      sideEffect: "financial",
      deviceOnly: true,
      requiresAuthentication: true,
      scopesOffered: ["once"],
      summary: "Pay shop.example 12.00 USD",
      details: { merchant: "shop.example", amount: "12.00 USD" },
    });
    const { unmount } = card(pay, true);
    expect(screen.getByRole("button", { name: "Allow with scope" })).toBeDefined();
    expect(screen.getByText(/Needs Touch ID/)).toBeDefined();
    unmount();
    card(pay, false);
    expect(screen.queryByRole("button", { name: "Allow with scope" })).toBeNull();
    expect(screen.getByText("Answer this on the device it was sent to.")).toBeDefined();
    const chat = renderForSurface("telegram:1", pay);
    expect(chat.text).toBe("Pay · financial\nAnswer this on your Mac.");
    expect(chat.buttons).toHaveLength(0);
  });

  it("a multi-line body keeps its lines inside the delimited block", async () => {
    const { container } = card(base);
    await userEvent.click(screen.getByRole("button", { name: "View" }));
    expect(container.querySelector("pre")?.textContent).toContain("Hi Jane,\n\nThanks");
  });
});

describe("QuestionCard renders through renderQuestionForSurface", () => {
  const request: InputRequest = {
    id: "inp_1",
    taskId: null,
    threadId: "thr_1",
    status: "open",
    answer: null,
    createdAt: new Date(STORY_NOW).toISOString(),
    answeredAt: null,
    answeredByDeviceId: null,
    questions: [
      {
        header: "When",
        question: "Which day?‮",
        multiSelect: false,
        options: [
          { label: "Tues\nday", description: "fits​the calendar" },
          { label: "Wednesday" },
        ],
      },
    ],
  };

  it("shows sanitized text and answers with the original label", async () => {
    const onAnswer = vi.fn();
    const { container } = render(<QuestionCard request={request} onAnswer={onAnswer} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Which day?⟨U+202E⟩");
    expect(text).toContain("Tues⏎day");
    expect(text).toContain("fits⟨U+200B⟩the calendar");
    expect(container.innerHTML).not.toContain("‮");
    await userEvent.click(screen.getByText("Tues⏎day"));
    await userEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(onAnswer).toHaveBeenCalledWith({ When: "Tues\nday" });
  });
});

describe("WrapUpBox sanitizes model text", () => {
  it("shows hidden characters and keeps the button's original message", async () => {
    const onAction = vi.fn();
    render(
      <WrapUpBox
        block={{
          type: "wrap_up",
          recap: "Done‮.",
          ask: "Ship it?​",
          actions: [{ label: "Yes‮", message: "yes, ship it" }],
        }}
        onAction={onAction}
      />,
    );
    expect(screen.getByText("Done⟨U+202E⟩.")).toBeDefined();
    expect(screen.getByText("Ship it?⟨U+200B⟩")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Yes⟨U+202E⟩" }));
    expect(onAction).toHaveBeenCalledWith("yes, ship it");
  });
});
