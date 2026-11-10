import type { ApprovalRequest } from "@psyche/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/blocks/ApprovalCard.tsx";
import { classifyAnswerError } from "../src/blocks/answer-error.ts";
import { GatewayRequestError } from "../src/data/client.ts";
import { createFixtureWorld, FIXTURE_NOW } from "../src/fixtures/index.ts";
import { activeI18n, createI18n, setActiveI18n } from "../src/i18n/core.ts";
import { UiSlotsProvider } from "../src/slots.tsx";

/**
 * A failed answer says why: a rate limit counts down and disables Allow, a Touch ID failure says
 * so, a window with no presence provider points at the Psyche app, a desktop window whose
 * Touch ID path is not ready names what is missing with its fix, and one click sends one answer. The generic tool card reads as fields, not JSON.
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

  it("the Gateway's request budget is not called an approvals limit", () => {
    // `scope` marks the per-device request budget: it said "Too many approvals" while the owner
    // had approved nothing, because a busy screen had used the budget up.
    for (const scope of ["requests", "side_effects"]) {
      const budget = new GatewayRequestError(
        "approvals.answer",
        "rate_limited",
        "Too many requests from this device; slow down",
        { scope, windowMs: 60_000, retryAfterSec: 30 },
      );
      const failure = classifyAnswerError(budget);
      expect(failure.kind).toBe("other");
      expect(failure).toMatchObject({ text: "Too many requests from this device; slow down" });
    }
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
        /Too many tries in a minute\. Try again in \d s\./,
      ),
    );
    expect(allow().disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    await waitFor(() => expect(allow().disabled).toBe(false));
    expect(screen.queryByText(/Too many tries/)).toBeNull();
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

  it("a window without a presence provider points at the Psyche app, not a notification", async () => {
    show(
      vi.fn().mockRejectedValue(
        new GatewayRequestError("approvals.answer", "forbidden", "x", {
          reason: "presence_required",
        }),
      ),
    );
    await userEvent.click(allow());
    const text = (await screen.findByRole("alert")).textContent ?? "";
    expect(text).toContain("Approve the change in the Psyche app on your Mac (Touch ID)");
    expect(text).not.toContain("notification");
  });

  it("classifies why the window's Touch ID cannot run, with the fix", () => {
    const why = (reason: string) =>
      classifyAnswerError(
        new GatewayRequestError("approvals.approveWithTouchId", "unavailable", "x", { reason }),
      );
    expect(why("helper_offline")).toMatchObject({ kind: "touch_id_setup", fix: "start_helper" });
    expect(why("no_presence_key")).toMatchObject({ kind: "touch_id_setup", fix: "open_devices" });
    expect(why("presence_key_invalidated")).toMatchObject({
      kind: "touch_id_setup",
      fix: "open_devices",
    });
    expect(why("helper_outdated")).toMatchObject({ kind: "touch_id_setup", fix: null });
    expect(why("presence_key_unavailable")).toMatchObject({ kind: "touch_id_setup", fix: null });
    // The retired keychain reasons are no longer known: they read as any other error.
    for (const reason of [
      "presence_key_untrusted",
      "presence_key_access_denied",
      "presence_key_changed",
      "presence_key_wrong_location",
      "presence_key_interaction_not_allowed",
      "presence_key_acl_unavailable",
    ]) {
      expect(why(reason).kind).toBe("other");
    }
    expect(why("something_else").kind).toBe("other");
    expect(
      classifyAnswerError(
        new GatewayRequestError("approvals.approveWithTouchId", "cancelled", "x"),
      ),
    ).toEqual({ kind: "cancelled" });
    expect(
      classifyAnswerError(
        new GatewayRequestError("approvals.approveWithTouchId", "cancelled", "x", {
          reason: "presence_cancelled",
        }),
      ),
    ).toEqual({ kind: "cancelled" });
  });

  it("a cancelled system sheet says nothing: no alert, Allow works again", async () => {
    const onAnswer = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayRequestError("approvals.approveWithTouchId", "cancelled", "x", {
          reason: "presence_cancelled",
        }),
      )
      .mockResolvedValue(undefined);
    show(onAnswer, approval({ requiresAuthentication: true }));
    await userEvent.click(allow());
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(allow().disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/cancel/i)).toBeNull();
    expect((screen.getByRole("button", { name: /^Deny/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await userEvent.click(allow());
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(2));
  });

  function showWithFix(
    onAnswer: (...a: unknown[]) => Promise<void>,
    touchIdFix: () => Promise<void>,
  ) {
    render(
      <UiSlotsProvider value={{ persona: { name: "Wren", creature: "moth" }, touchIdFix }}>
        <ApprovalCard
          approval={approval({ requiresAuthentication: true })}
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

  it("helper down: says so and offers Start Psyche Helper, then waits for Allow again", async () => {
    const onAnswer = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayRequestError("approvals.approveWithTouchId", "unavailable", "x", {
          reason: "helper_offline",
        }),
      )
      .mockResolvedValueOnce(undefined);
    const fix = vi.fn(async () => undefined);
    showWithFix(onAnswer, fix);
    await userEvent.click(allow());
    expect((await screen.findByRole("alert")).textContent).toContain("Psyche Helper isn't running");
    expect(screen.queryByText(/notification/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Start Psyche Helper" }));
    expect(fix).toHaveBeenCalledWith("start_helper");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    // Never approves on its own (security review, finding 1): the owner clicks Allow again.
    expect(onAnswer).toHaveBeenCalledTimes(1);
    await userEvent.click(allow());
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(2));
  });

  it("no key: sends the owner to Settings → Devices instead of registering from the card", async () => {
    const fix = vi.fn(async () => undefined);
    const onAnswer = vi.fn().mockRejectedValue(
      new GatewayRequestError("approvals.approveWithTouchId", "unavailable", "x", {
        reason: "no_presence_key",
      }),
    );
    showWithFix(onAnswer, fix);
    await userEvent.click(allow());
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Touch ID isn't set up for approvals",
    );
    expect(screen.queryByRole("button", { name: "Set up Touch ID" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open Settings → Devices" }));
    expect(fix).toHaveBeenCalledWith("open_devices");
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it("from the window, Always becomes once, and the card says so before and after", async () => {
    const onAnswer = vi.fn(async () => undefined);
    const a = approval({ requiresAuthentication: true, scopesOffered: ["once", "always"] });
    const { rerender } = render(
      <UiSlotsProvider
        value={{ persona: { name: "Wren", creature: "moth" }, touchIdOnceOnly: true }}
      >
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
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Allow for" }), "always");
    expect(screen.getByTestId("touch-id-once-only").textContent).toContain("once only");
    await userEvent.click(allow());
    await waitFor(() => expect(onAnswer).toHaveBeenCalled());
    rerender(
      <UiSlotsProvider
        value={{ persona: { name: "Wren", creature: "moth" }, touchIdOnceOnly: true }}
      >
        <ApprovalCard
          approval={{ ...a, status: "approved", scopeGranted: "once", decidedAt: FIXTURE_NOW }}
          persona="Wren"
          canAnswer
          now={NOW}
          armDelayMs={0}
          mode="balanced"
          onAnswer={onAnswer as never}
        />
      </UiSlotsProvider>,
    );
    expect(document.body.textContent).toContain(
      "Allowed once (Touch ID approvals from this window are once only)",
    );
  });

  it("shows the approval code the Touch ID sheet names", () => {
    showWithFix(vi.fn(), vi.fn());
    expect(screen.getByTestId("approval-code").textContent).toMatch(
      /^Code [0-9a-f]{4}-[0-9a-f]{4}$/,
    );
  });

  it("a helper without a keychain access group says exactly that, with no button", async () => {
    showWithFix(
      vi.fn().mockRejectedValue(
        new GatewayRequestError("approvals.approveWithTouchId", "unavailable", "x", {
          reason: "presence_key_unavailable",
        }),
      ),
      vi.fn(),
    );
    await userEvent.click(allow());
    expect((await screen.findByRole("alert")).textContent).toContain("can't keep a Touch ID key");
    expect(screen.queryByTestId("touch-id-fix")).toBeNull();
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

describe("purchase card amounts", () => {
  const purchase = (details: Record<string, unknown>) =>
    approval({
      kind: "purchase",
      sideEffect: "financial",
      summary: "Pay for the order",
      details,
    } as Partial<ApprovalRequest>);

  it("formats the browser producer's shape: digit string, currency, merchantOrigin", () => {
    const before = activeI18n();
    setActiveI18n(createI18n({ locale: "en-US" }));
    try {
      show(
        vi.fn(),
        purchase({
          merchantOrigin: "https://shop.example",
          amount: "412.80",
          currency: "EUR",
          lineItemHash: "x",
          submit: "Place order",
        }),
      );
      expect(screen.getByText("€412.80")).toBeTruthy();
      expect(screen.getByText("https://shop.example")).toBeTruthy();
      // The amount carries its currency, so the row would only repeat it.
      expect(screen.queryByText("Currency")).toBeNull();
    } finally {
      setActiveI18n(before);
    }
  });

  it("keeps the Currency row when the amount cannot be formatted", () => {
    show(
      vi.fn(),
      purchase({ merchantOrigin: "https://shop.example", amount: "about 40", currency: "EUR" }),
    );
    expect(screen.getByText("about 40")).toBeTruthy();
    expect(screen.getByText("Currency")).toBeTruthy();
  });

  it("uses the display string and quantity of the number shape", () => {
    show(
      vi.fn(),
      purchase({
        merchant: "Atlântico Air",
        amount: 412.8,
        currency: "EUR",
        amountDisplay: "€412.80",
        lineItems: [{ name: "Seat selection", quantity: 2, amount: 15 }],
      }),
    );
    expect(screen.getAllByText("€412.80").length).toBeGreaterThan(0);
    expect(screen.getByText("Atlântico Air")).toBeTruthy();
    expect(screen.getByText(/2 × Seat selection/)).toBeTruthy();
  });
});
