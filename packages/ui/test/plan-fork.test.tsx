import type { ApprovalRequest } from "@psyche/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { IDS } from "../src/fixtures/index.ts";
import { PlanForkNavContext } from "../src/plan-fork/data.ts";
import { PlanForkCard, PlanTakenLine } from "../src/plan-fork/ForkCard.tsx";
import {
  AUSTIN_REPORT,
  austinStaged,
  STAY_REPORT,
  seedPlanForks,
} from "../src/plan-fork/mock-plan-fork.ts";
import {
  checkApproval,
  costTotals,
  earliestDeadline,
  parseCompareArg,
  readyOptions,
  type TakeSelection,
} from "../src/plan-fork/model.ts";
import { PlansView } from "../src/plan-fork/PlansView.tsx";
import { PlanForkStartSheet } from "../src/plan-fork/StartSheet.tsx";
import { initialTicks, selectionOf } from "../src/plan-fork/TakeSheet.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

const card = (items: unknown, kind = "staged_apply"): Pick<ApprovalRequest, "kind" | "details"> =>
  ({ kind, details: { items } }) as Pick<ApprovalRequest, "kind" | "details">;
/** A card child as the Gateway sends it: `<itemId>` for the change, `<itemId>:send` for its send. */
const item = (itemId: string, bindingHash: string) => ({
  itemId,
  tool: "mail_draft_reply",
  summary: "x",
  bindingHash,
});
const sel = (items: [string, string][], sends: [string, string][] = []): TakeSelection => ({
  items: items.map(([itemId, bindingHash]) => ({ itemId, bindingHash })),
  sends: sends.map(([itemId, sendHash]) => ({ itemId, sendHash })),
});

describe("checkApproval (stagedApplyMatchesSelection): the card must list exactly what was ticked", () => {
  const ticked = sel([
    ["a", "sha256:a"],
    ["b", "sha256:b"],
  ]);
  const both = [item("a", "sha256:a"), item("b", "sha256:b")];
  const table: [string, Pick<ApprovalRequest, "kind" | "details">, TakeSelection, "ok" | string][] =
    [
      ["the exact set", card(both), ticked, "ok"],
      ["the exact set in another order", card([...both].reverse()), ticked, "ok"],
      ["an extra item", card([...both, item("c", "sha256:c")]), ticked, "mismatch"],
      ["a missing item", card([item("a", "sha256:a")]), ticked, "mismatch"],
      [
        "a repeated item on the card",
        card([item("a", "sha256:a"), item("a", "sha256:a")]),
        sel([["a", "sha256:a"]]),
        "mismatch",
      ],
      [
        "a changed hash",
        card([item("a", "sha256:a"), item("b", "sha256:CHANGED")]),
        ticked,
        "mismatch",
      ],
      [
        "a swapped item with a known hash",
        card([item("a", "sha256:b"), item("b", "sha256:a")]),
        ticked,
        "mismatch",
      ],
      ["the wrong kind", card(both, "batch"), ticked, "wrong_kind"],
      ["no item list", { kind: "staged_apply", details: {} } as never, ticked, "mismatch"],
      ["a malformed item", card([{ itemId: "a" }]), ticked, "mismatch"],
      [
        "a send child the owner did not tick",
        card([item("a", "sha256:a"), item("a:send", "sha256:s")]),
        sel([["a", "sha256:a"]]),
        "mismatch",
      ],
      [
        "a send tick the card does not carry",
        card([item("a", "sha256:a")]),
        sel([["a", "sha256:a"]], [["a", "s"]]),
        "mismatch",
      ],
      [
        "a send tick on an item not ticked",
        card([item("a", "sha256:a")]),
        sel([["a", "sha256:a"]], [["z", "s"]]),
        "mismatch",
      ],
      [
        "a ticked send the card carries",
        card([item("a", "sha256:a"), item("a:send", "sha256:s")]),
        sel([["a", "sha256:a"]], [["a", "s"]]),
        "ok",
      ],
      [
        "an empty selection against a card with items",
        card([item("a", "sha256:a")]),
        sel([]),
        "mismatch",
      ],
    ];
  it.each(table)("%s", (_name, approval, selection, want) => {
    const out = checkApproval(approval, selection);
    expect(out.ok ? "ok" : out.reason).toBe(want);
  });
});

describe("totals, deadlines and options come from code", () => {
  it("sums per currency and period and flags estimates", () => {
    const totals = costTotals(AUSTIN_REPORT.costs);
    expect(totals).toEqual([
      { currency: "USD", period: "once", amount: 4250, includesEstimate: true },
      { currency: "USD", period: "month", amount: 2150, includesEstimate: true },
    ]);
    expect(costTotals(STAY_REPORT.costs)).toEqual([
      { currency: "USD", period: "month", amount: 1980, includesEstimate: false },
    ]);
  });
  it("never adds across currencies", () => {
    const [c] = AUSTIN_REPORT.costs;
    if (c === undefined) throw new Error("fixture");
    const mixed = costTotals([c, { ...c, id: "x", currency: "EUR" }]);
    expect(mixed.map((m) => m.currency)).toEqual(["EUR", "USD"]);
  });
  it("finds the earliest deadline only among deadlines", () => {
    expect(earliestDeadline(AUSTIN_REPORT)?.date).toBe("2027-04-01");
  });
  it("parses /compare labels and checks the start sheet's rows", () => {
    expect(parseCompareArg("Move to Austin | Stay")).toEqual(["Move to Austin", "Stay"]);
    expect(parseCompareArg("")).toEqual([]);
    expect(readyOptions([{ label: "A", premise: "x" }])).toBeNull();
    expect(
      readyOptions([
        { label: "A", premise: "x" },
        { label: " ", premise: "y" },
      ]),
    ).toBeNull();
    expect(
      readyOptions([
        { label: "A", premise: "x" },
        { label: "B", premise: "y" },
      ]),
    ).toHaveLength(2);
  });
  it("ticks fresh items, never a send, and drops a send whose item is unticked", () => {
    const items = austinStaged();
    const ticks = initialTicks(items);
    expect(Object.values(ticks.items).every(Boolean)).toBe(true);
    expect(Object.values(ticks.sends).every((v) => v === false)).toBe(true);
    expect(selectionOf(items, ticks).sends).toEqual([]);
    const withSend = {
      items: { ...ticks.items, stg_austin_mail: false },
      sends: { stg_austin_mail: true },
    };
    expect(selectionOf(items, withSend).sends).toEqual([]);
    const stale = items.map((i) =>
      i.id === "stg_austin_cal" ? { ...i, status: "stale" as const } : i,
    );
    expect(initialTicks(stale).items.stg_austin_cal).toBe(false);
  });
});

function renderView(opts: { layout?: "tabs" | "columns"; edit?: (g: MockGateway) => void } = {}) {
  const ref: { gateway?: MockGateway } = {};
  const onBack = vi.fn();
  render(
    <StoryWorld
      edit={(w) => {
        w.planForks = seedPlanForks("ready", IDS.threads.main);
      }}
      onGateway={(g) => {
        ref.gateway = g;
        opts.edit?.(g);
      }}
    >
      <PlansView forkId="fork_1" onBack={onBack} layout={opts.layout ?? "columns"} />
    </StoryWorld>,
  );
  return { ref, onBack };
}

describe("the Plans view", () => {
  it("shows a lane per branch and the comparison, with estimates labelled", async () => {
    renderView();
    expect(await screen.findByTestId("lane-fbr_austin")).toBeTruthy();
    expect(screen.getByTestId("lane-fbr_stay")).toBeTruthy();
    const compare = screen.getByTestId("plan-compare");
    expect(within(compare).getAllByText("Estimate").length).toBeGreaterThan(0);
    expect(within(compare).getByTestId("total-fbr_austin").textContent).toContain(
      "includes estimates",
    );
    // The stay branch's rent came from a cited mail, so its total is not an estimate.
    expect(within(compare).getByTestId("total-fbr_stay").textContent).not.toContain("estimate");
    // An item that lost every cite says so.
    await userEvent.click(within(compare).getByRole("button", { name: "Show all rows" }));
    expect(within(compare).getByText("No source")).toBeTruthy();
  });

  it("hides rows that do not differ until Show all rows", async () => {
    renderView();
    const compare = await screen.findByTestId("plan-compare");
    expect(within(compare).queryByText("What you give up")).toBeNull();
    await userEvent.click(within(compare).getByRole("button", { name: "Show all rows" }));
    expect(within(compare).getByText("What you give up")).toBeTruthy();
  });

  it("turns the lanes into tabs in a narrow window", async () => {
    renderView({ layout: "tabs" });
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Compare", "Move to Austin", "Stay"]);
    expect(screen.queryByTestId("lane-fbr_austin")).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Move to Austin" }));
    expect(await screen.findByTestId("lane-fbr_austin")).toBeTruthy();
  });

  it("goes back to the transcript", async () => {
    const { onBack } = renderView();
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
  });

  it("withholds model text and totals on a scrubbed read", async () => {
    renderView({
      edit: (g) => {
        const w = g.world.planForks;
        if (w === undefined) return;
        w.branches = w.branches.map((b) => ({
          ...b,
          scrub: { hiddenItems: 2, textHidden: true, totalsHidden: true },
        }));
      },
    });
    const compare = await screen.findByTestId("plan-compare");
    expect(within(compare).getByTestId("total-fbr_austin").textContent).toBe("Total on your Mac");
    expect(within(compare).queryByText(/Austin costs more/)).toBeNull();
    expect(
      within(screen.getByTestId("lane-fbr_austin")).getByText("Open on your Mac to read this"),
    ).toBeTruthy();
  });
});

describe("Take this plan", () => {
  const open = async () => {
    const view = renderView();
    await userEvent.click(
      await screen.findByRole("button", { name: "Take the plan: Move to Austin" }),
    );
    const sheet = await screen.findByTestId("plan-take-sheet");
    await within(sheet).findByText("Reply to your landlord about leaving");
    return { ...view, sheet };
  };
  const answers = (g: MockGateway) => g.calls.filter((c) => c.method === "approvals.answer");

  it("ticks fresh items, leaves every send unticked and answers the exact set", async () => {
    const { ref, sheet } = await open();
    const send = within(sheet).getByRole("checkbox", { name: /Send it too/ });
    expect(send.getAttribute("aria-checked")).toBe("false");
    for (const name of [
      "Reply to your landlord about leaving",
      "Block the move days",
      "Remind you to forward your mail",
    ]) {
      expect(within(sheet).getByRole("checkbox", { name }).getAttribute("aria-checked")).toBe(
        "true",
      );
    }
    await userEvent.click(within(sheet).getByRole("button", { name: "Take this plan" }));
    await waitFor(() => expect(answers(ref.gateway as MockGateway)).toHaveLength(1));
    const take = (ref.gateway as MockGateway).calls.find((c) => c.method === "planForks.take");
    expect(take?.params).toMatchObject({ sends: [] });
    await waitFor(() =>
      expect((ref.gateway as MockGateway).world.approvals.at(-1)?.status).toBe("approved"),
    );
  });

  it("sends only the item whose own Send it too box was ticked", async () => {
    const { ref, sheet } = await open();
    await userEvent.click(within(sheet).getByRole("checkbox", { name: /Send it too/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Take this plan" }));
    await waitFor(() => expect(answers(ref.gateway as MockGateway)).toHaveLength(1));
    const take = (ref.gateway as MockGateway).calls.find((c) => c.method === "planForks.take");
    expect(
      (take?.params as { sends: { itemId: string }[] } | undefined)?.sends.map((s) => s.itemId),
    ).toEqual(["stg_austin_mail"]);
  });

  it("takes only the items left ticked, and the card carries exactly those", async () => {
    const { ref, sheet } = await open();
    await userEvent.click(within(sheet).getByRole("checkbox", { name: "Block the move days" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Take this plan" }));
    await waitFor(() => expect(answers(ref.gateway as MockGateway)).toHaveLength(1));
    const g = ref.gateway as MockGateway;
    const take = g.calls.find((c) => c.method === "planForks.take");
    const ids = (take?.params as { items: { itemId: string }[] } | undefined)?.items.map(
      (i) => i.itemId,
    );
    expect(ids).toEqual(["stg_austin_mail", "stg_austin_rem"]);
    const card = g.world.approvals.at(-1)?.details as { items: { itemId: string }[] };
    expect(card.items.map((i) => i.itemId)).toEqual(ids);
  });

  it("refuses to answer when the approval lists an extra, a missing or a changed item", async () => {
    const tampers: [string, (rows: Record<string, unknown>[]) => Record<string, unknown>[]][] = [
      ["extra", (rows) => [...rows, { ...(rows[0] as object), itemId: "stg_other" }]],
      ["missing", (rows) => rows.slice(1)],
      [
        "changed",
        (rows) => rows.map((r, i) => (i === 0 ? { ...r, bindingHash: "sha256:evil" } : r)),
      ],
    ];
    for (const [, tamper] of tampers) {
      const { ref, sheet } = await open();
      const w = (ref.gateway as MockGateway).world.planForks;
      if (w === undefined) throw new Error("world");
      w.tamper = tamper;
      await userEvent.click(within(sheet).getByRole("button", { name: "Take this plan" }));
      expect(await within(sheet).findByText(/doesn't match what you ticked/)).toBeTruthy();
      expect(answers(ref.gateway as MockGateway)).toHaveLength(0);
      expect((ref.gateway as MockGateway).world.approvals.at(-1)?.status).toBe("pending");
      cleanup();
    }
  });
});

describe("the start sheet and the fork card", () => {
  it("prefills a suggestion, shows the worst-case cost and starts a fork", async () => {
    const ref: { gateway?: MockGateway } = {};
    const onStarted = vi.fn();
    render(
      <StoryWorld
        edit={(w) => {
          w.planForks = { forks: [], branches: [], staged: {} };
        }}
        onGateway={(g) => {
          ref.gateway = g;
        }}
      >
        <PlanForkStartSheet
          open
          onOpenChange={() => {}}
          threadId={IDS.threads.main}
          messageId={IDS.messages.mainAgent}
          onStarted={onStarted}
        />
      </StoryWorld>,
    );
    const start = await screen.findByRole("button", { name: "Start" });
    await waitFor(() =>
      expect(screen.getByLabelText("Name of option 1")).toHaveProperty("value", "Move to Austin"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("plan-fork-estimate").textContent).toContain("Up to about $0.40"),
    );
    expect(screen.getByTestId("plan-fork-estimate").textContent).toContain(
      "Changes nothing until you take a plan",
    );
    await userEvent.click(start);
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(ref.gateway?.world.planForks?.forks).toHaveLength(1);
  });

  it("refuses in an incognito chat and fills rows from /compare labels", async () => {
    const { rerender } = render(
      <StoryWorld>
        <PlanForkStartSheet
          open
          onOpenChange={() => {}}
          threadId={IDS.threads.main}
          messageId="m"
          incognito
          onStarted={() => {}}
        />
      </StoryWorld>,
    );
    expect(await screen.findByText("Forks aren't available in incognito chats.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    rerender(<div />);
    cleanup();
    render(
      <StoryWorld>
        <PlanForkStartSheet
          open
          onOpenChange={() => {}}
          threadId={IDS.threads.main}
          messageId="m"
          labels={["Rent", "Buy"]}
          onStarted={() => {}}
        />
      </StoryWorld>,
    );
    expect(await screen.findByLabelText("Name of option 2")).toHaveProperty("value", "Buy");
  });

  it("shows a running fork with a step per branch and Cancel, then Compare once ready", async () => {
    const openPlans = vi.fn();
    const ref: { gateway?: MockGateway } = {};
    render(
      <StoryWorld
        edit={(w) => {
          w.planForks = seedPlanForks("running", IDS.threads.main);
        }}
        onGateway={(g) => {
          ref.gateway = g;
        }}
      >
        <PlanForkNavContext.Provider value={{ start: () => {}, openPlans }}>
          <PlanForkCard forkId="fork_1" now={Date.parse("2026-11-25T09:01:05Z")} />
        </PlanForkNavContext.Provider>
      </StoryWorld>,
    );
    expect(await screen.findByText("Waiting for a slot")).toBeTruthy();
    expect(screen.getByText("$0.21 of $1.00")).toBeTruthy();
    expect(screen.getByText("1:05")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(ref.gateway?.calls.some((c) => c.method === "planForks.cancel")).toBe(true),
    );
  });

  it("offers Compare on a ready fork", async () => {
    const openPlans = vi.fn();
    render(
      <StoryWorld
        edit={(w) => {
          w.planForks = seedPlanForks("ready", IDS.threads.main);
        }}
      >
        <PlanForkNavContext.Provider value={{ start: () => {}, openPlans }}>
          <PlanForkCard forkId="fork_1" />
        </PlanForkNavContext.Provider>
      </StoryWorld>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Compare" }));
    expect(openPlans).toHaveBeenCalledWith("fork_1");
    expect(screen.getByText("Move to Austin vs Stay", { exact: false })).toBeTruthy();
  });
});

describe("Continue after a plan was taken while the chat was busy", () => {
  const pending = (g: MockGateway, busy = false) => {
    const w = g.world.planForks;
    if (w === undefined) return;
    w.chatBusy = busy;
    w.forks = w.forks.map((f) => ({
      ...f,
      status: "taken" as const,
      takenBranchId: "fbr_austin",
      error: "continue_pending",
    }));
  };
  const renderTaken = (busy = false) => {
    const ref: { gateway?: MockGateway } = {};
    render(
      <StoryWorld
        edit={(w) => {
          w.planForks = seedPlanForks("ready", IDS.threads.main);
        }}
        onGateway={(g) => {
          ref.gateway = g;
          pending(g, busy);
        }}
      >
        <PlanTakenLine forkId="fork_1" branchId="fbr_austin" />
      </StoryWorld>,
    );
    return ref;
  };

  it("shows Continue only while the turn is pending, and one tap starts it", async () => {
    const ref = renderTaken();
    await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Continue" })).toBeNull());
    const call = ref.gateway?.calls.find((c) => c.method === "planForks.take");
    expect(call?.params).toMatchObject({ items: [], sends: [], continue: true });
    expect(ref.gateway?.world.planForks?.forks[0]?.error).toBeNull();
  });

  it("keeps the button and says so when the chat is still replying", async () => {
    renderTaken(true);
    await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("The chat is still replying. Try again when it ends."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("offers no Continue for a taken plan that already started", async () => {
    render(
      <StoryWorld
        edit={(w) => {
          w.planForks = seedPlanForks("taken", IDS.threads.main);
        }}
      >
        <PlanTakenLine forkId="fork_1" branchId="fbr_austin" />
      </StoryWorld>,
    );
    await screen.findByTestId("plan-taken");
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  });
});
