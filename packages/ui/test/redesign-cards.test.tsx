import type { InputRequest } from "@psyche/protocol";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DisclosureProvider } from "../src/blocks/disclosure.tsx";
import { QuestionCard } from "../src/blocks/QuestionCard.tsx";
import { ReceiptLine } from "../src/blocks/Receipt.tsx";
import { WrapUpBox } from "../src/blocks/WrapUp.tsx";
import { createFixtureWorld, IDS } from "../src/fixtures/index.ts";
import { STORY_NOW } from "../src/stories/harness.tsx";

/** Redesign 2026 §5.3: question card, wrap-up box and receipt line. */

const world = createFixtureWorld();
const receipt = (id: string) => {
  const r = world.receipts.find((x) => x.id === id);
  if (r === undefined) throw new Error(`fixture receipt ${id} missing`);
  return r;
};

const request = (over: Partial<InputRequest> = {}): InputRequest => ({
  id: "inp_cards",
  taskId: null,
  threadId: "thr_1",
  status: "open",
  answer: null,
  createdAt: new Date(STORY_NOW).toISOString(),
  answeredAt: null,
  answeredByDeviceId: null,
  questions: [
    {
      header: "Slot",
      question: "Which time works?",
      multiSelect: false,
      options: [{ label: "Tue 2:30" }, { label: "Wed 9:00 (recommended)" }, { label: "Thu 4:15" }],
    },
    {
      header: "Remind me",
      question: "When should I remind you?",
      multiSelect: true,
      options: [{ label: "A day before" }, { label: "An hour before" }],
    },
  ],
  ...over,
});

describe("QuestionCard (§5.3)", () => {
  it("is a level-1 surface with sentence-case headers and chip capsules", () => {
    const { container } = render(<QuestionCard request={request()} onAnswer={() => {}} />);
    const card = container.querySelector("article") as HTMLElement;
    expect(card.className).toContain("bg-surface-raised");
    expect(card.className).toContain("shadow-elevation-1");
    expect(card.className).not.toMatch(/\bborder-gray|\boutline-|\bbg-gray-2\b/);
    // The retired uppercase `text-label` (not the `text-label-*` colour roles).
    expect(container.innerHTML).not.toMatch(
      /(?<![\w-])text-label(?![\w-])|\buppercase\b|cursor-pointer/,
    );
    const slot = within(screen.getByRole("radiogroup", { name: "Which time works?" }));
    // Recommended first, preselected for single-select.
    const radios = slot.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual([
      "Wed 9:00 recommended",
      "Tue 2:30",
      "Thu 4:15",
      "Other",
    ]);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[1]?.className).toContain("rounded-full");
    expect(radios[1]?.className).toContain("bg-fill-tertiary");
    expect(screen.getByText("Slot").className).toContain("text-caption");
  });

  it("picks chips with 1–9 and answers with ⌘Return", async () => {
    const onAnswer = vi.fn();
    render(<QuestionCard request={request()} onAnswer={onAnswer} />);
    const user = userEvent.setup();
    const answer = screen.getByRole("button", { name: "Answer" });
    expect(answer.className).toContain("bg-primary");

    const slot = within(screen.getByRole("radiogroup", { name: "Which time works?" }));
    (slot.getAllByRole("radio")[0] as HTMLElement).focus();
    await user.keyboard("3");
    expect(slot.getByRole("radio", { name: "Thu 4:15" }).getAttribute("aria-checked")).toBe("true");
    expect(slot.getByRole("radio", { name: /Wed 9:00/ }).getAttribute("aria-checked")).toBe(
      "false",
    );

    const remind = screen.getByRole("checkbox", { name: "A day before" });
    remind.focus();
    await user.keyboard("1");
    await user.keyboard("2");
    expect(remind.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByRole("checkbox", { name: "An hour before" }).getAttribute("aria-checked"),
    ).toBe("true");

    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onAnswer).toHaveBeenCalledWith({
      Slot: "Thu 4:15",
      "Remind me": ["A day before", "An hour before"],
    });
  });

  it("keeps Other as free text and Skip as a plain button before the trailing Answer", async () => {
    const onAnswer = vi.fn();
    const onSkip = vi.fn();
    render(<QuestionCard request={request()} onAnswer={onAnswer} onSkip={onSkip} />);
    const user = userEvent.setup();
    const skip = screen.getByRole("button", { name: "Skip for now" });
    const answer = screen.getByRole("button", { name: "Answer" });
    expect(skip.className).toContain("text-accent-11");
    expect(skip.className).not.toContain("bg-primary");
    expect(skip.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.type(screen.getByRole("textbox", { name: "Slot: other answer" }), "Fri 11:00");
    await user.click(screen.getByRole("checkbox", { name: "An hour before" }));
    await user.click(answer);
    expect(onAnswer).toHaveBeenCalledWith({ Slot: "Fri 11:00", "Remind me": ["An hour before"] });
    await user.click(skip);
    expect(onSkip).toHaveBeenCalled();
  });

  it("collapses to one line per question with a Change link once answered", async () => {
    const onChangeAnswer = vi.fn();
    const { container } = render(
      <QuestionCard
        request={request({
          status: "answered",
          answer: { Slot: "Tue 2:30", "Remind me": ["A day before", "An hour before"] },
        })}
        onChangeAnswer={onChangeAnswer}
      />,
    );
    const rows = within(container.querySelector("ul") as HTMLElement).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toBe("SlotTue 2:30Change");
    expect(rows[1]?.textContent).toBe("Remind meA day before, An hour beforeChange");
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Change the answer to Remind me" }));
    expect(onChangeAnswer).toHaveBeenCalledWith("Remind me");
  });
});

describe("WrapUpBox (§5.3)", () => {
  it("is a level-1 card whose first action is the trailing primary", async () => {
    const onAction = vi.fn();
    const { container } = render(
      <WrapUpBox
        block={{
          type: "wrap_up",
          recap: "Held Tue 2:30.",
          ask: "Add it to your calendar?",
          actions: [{ label: "Add it", message: "add it" }, { label: "Not now" }],
        }}
        onAction={onAction}
      />,
    );
    const card = screen.getByRole("article", { name: "Wrap-up" });
    expect(card.className).toContain("bg-surface-raised");
    expect(card.className).toContain("shadow-elevation-1");
    expect(screen.getByText("Held Tue 2:30.").className).toContain("text-reading");
    expect(screen.getByText("Add it to your calendar?").className).toContain("text-headline");
    const primary = screen.getByRole("button", { name: "Add it" });
    const second = screen.getByRole("button", { name: "Not now" });
    expect(primary.className).toContain("bg-primary");
    expect(second.className).not.toContain("bg-primary");
    const buttons = container.querySelectorAll("button");
    expect(buttons[buttons.length - 1]).toBe(primary);
    await userEvent.click(primary);
    expect(onAction).toHaveBeenCalledWith("add it");
  });
});

describe("ReceiptLine (§5.3)", () => {
  it("says outcome unknown once", () => {
    const { container } = render(<ReceiptLine receipt={receipt(IDS.receipts.holdUncertain)} />);
    expect((container.textContent ?? "").match(/outcome unknown/gi)).toHaveLength(1);
    expect(container.querySelector("[data-status]")?.getAttribute("data-status")).toBe("waiting");
  });

  it("leads with one status glyph and shows raw refs only at level 2", () => {
    const r = receipt(IDS.receipts.emailSent);
    const one = render(<ReceiptLine receipt={r} onOpen={() => {}} />);
    const line = one.getByRole("button");
    expect(line.className).toContain("text-callout");
    expect(line.className).toContain("text-label-secondary");
    expect(line.className).toContain("hover:bg-fill-tertiary");
    expect(line.className).not.toContain("cursor-pointer");
    expect(one.container.querySelectorAll("[data-status]")).toHaveLength(1);
    expect(one.container.querySelector("[data-status]")?.getAttribute("data-status")).toBe("done");
    expect(one.container.textContent).toContain("Gmail id 18c4…");
    expect(one.container.textContent).not.toContain("r-107");
    expect(one.container.querySelector(".font-mono")).toBeNull();
    one.unmount();

    const two = render(
      <DisclosureProvider initial={2} keyboard={false}>
        <ReceiptLine receipt={r} />
      </DisclosureProvider>,
    );
    const raw = two.container.querySelector(".font-mono") as HTMLElement;
    expect(raw.className).toContain("text-mono");
    expect(raw.textContent).toContain("r-107");
    expect(raw.textContent).toContain("gmailThreadId 18c4f2a9e3b1d7c0");
  });

  it("marks a failed write with the failed glyph and keeps the words neutral", () => {
    const { container } = render(<ReceiptLine receipt={receipt(IDS.receipts.cancelFailed)} />);
    expect(container.querySelector("[data-status]")?.getAttribute("data-status")).toBe("failed");
    // Danger colours only the glyph (§3.3), never the sentence.
    expect(container.querySelectorAll("span.text-danger-text")).toHaveLength(0);
    expect((container.textContent ?? "").match(/failed/g)).toHaveLength(1);
  });
});
