import type { ApprovalRequest } from "@psyche/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { classifyAnswerError } from "../src/blocks/answer-error.ts";
import { GatewayRequestError } from "../src/data/client.ts";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

/**
 * A failed answer says why: a rate limit counts down and disables Allow, a Touch ID failure says
 * so, a window with no presence provider points at the notification, and one click sends one
 * answer. The generic tool card reads as fields, not JSON.
 */

const NOW = Date.parse(FIXTURE_NOW);

function approval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const base = createFixtureWorld().approvals.find((a) => a.status === "pending");
  if (!base) throw new Error("no pending approval fixture");
  return {
    ...base,
    kind: "policy_change",
    sideEffect: "destructive",
    summary: "Use your Psyche Chrome profile for this task",
    details: {
      tool: "browser.use_real_chrome",
      params: { url: "https://canvas.ucsc.edu/", reason: "Check Canvas" },
      target: { kind: "app", value: "chrome" },
    },
    target: { kind: "app", value: "chrome", display: "chrome" },
    deviceOnly: true,
    taint: false,
    scopesOffered: ["once"],
    ...over,
  } as ApprovalRequest;
}

function show(onAnswer: (...a: unknown[]) => Promise<void>, a = approval()) {
  render(
    <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" } }}>
      <ApprovalCard
        approval={a}
        persona="Wren"
        canAnswer
        now={NOW}
        armDelayMs={0}
        mode="balanced"
        onAnswer={onAnswer as never}
      />
    </UiSlotsProvider>,
  );
}

const allow = () => screen.getByRole("button", { name: "Allow with scope" }) as HTMLButtonElement;

afterEach(() => vi.useRealTimers());

describe("answer failures on the card", () => {
  it("classifies rate limits, presence and other errors", () => {
    const limited = new GatewayRequestError("approvals.answer", "rate_limited", "x", {
      retryAfterSec: 12,
    });
    expect(classifyAnswerError(limited)).toEqual({ kind: "rate_limited", retryAfterSec: 12 });
    const noPresence = new GatewayRequestError("approvals.answer", "forbidden", "x", {
      reason: "presence_required",
    });
    expect(classifyAnswerError(noPresence).kind).toBe("presence_unavailable");
    const bad = new GatewayRequestError("approvals.answer", "forbidden", "x", {
      reason: "presence_invalid",
    });
    expect(classifyAnswerError(bad).kind).toBe("presence_failed");
    expect(classifyAnswerError(new Error("boom")).kind).toBe("other");
  });

  it("a rate limit shows a countdown and disables Allow until it ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onAnswer = vi
      .fn()
      .mockRejectedValue(
        new GatewayRequestError("approvals.answer", "rate_limited", "x", { retryAfterSec: 3 }),
      );
    show(onAnswer);
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(allow());
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /Too many approvals in a minute\. Try again in \d s\./,
      ),
    );
    expect(allow().disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    await waitFor(() => expect(allow().disabled).toBe(false));
    expect(screen.queryByText(/Too many approvals/)).toBeNull();
  });

  it("a Touch ID failure is shown on the card", async () => {
    const err = Object.assign(new Error("Touch ID was cancelled"), { name: "PresenceError" });
    show(vi.fn().mockRejectedValue(err));
    await userEvent.click(allow());
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Touch ID failed: Touch ID was cancelled. Try again.",
    );
    expect(allow().disabled).toBe(false);
  });

  it("a window without a presence provider points at the notification", async () => {
    show(
      vi.fn().mockRejectedValue(
        new GatewayRequestError("approvals.answer", "forbidden", "x", {
          reason: "presence_required",
        }),
      ),
    );
    await userEvent.click(allow());
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Approve the change with Touch ID in the Psyche notification",
    );
  });

  it("two quick clicks send one answer while it is in flight", async () => {
    let release: () => void = () => undefined;
    const onAnswer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    show(onAnswer);
    const b = allow();
    fireEvent.click(b, { detail: 1 });
    fireEvent.click(b, { detail: 1 });
    await waitFor(() => expect(allow().disabled).toBe(true));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });
});

describe("generic tool card formatting", () => {
  it("shows params as fields, one Target row, and human wording", () => {
    show(vi.fn());
    expect(screen.getByText("URL")).toBeTruthy();
    expect(screen.getByText("https://canvas.ucsc.edu/")).toBeTruthy();
    expect(screen.getByText("Reason")).toBeTruthy();
    expect(screen.getAllByText("Target")).toHaveLength(1);
    expect(screen.queryByText(/\{"kind"/)).toBeNull();
    expect(screen.queryByText(/balanced mode; destructive/)).toBeNull();
    expect(screen.getByText(/Balanced mode asks before it changes settings or data/)).toBeTruthy();
  });
});
