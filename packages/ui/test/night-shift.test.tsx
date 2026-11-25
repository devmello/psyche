import type { ApprovalRequest, StagedAction } from "@psyche/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockGateway } from "../src/data/mock-gateway.ts";
import { HomeScreen } from "../src/home/HomeScreen.tsx";
import {
  NIGHT_IDS,
  type NightShiftWorld,
  nightShiftFixture,
  tamperApprovals,
} from "../src/night-shift/mock-night-shift.ts";
import {
  buildApply,
  checkApproval,
  EMPTY_SELECTION,
  markOpened,
  markRefused,
  readPreview,
  reconcile,
  seedSelection,
  selectAll,
  toggleItem,
  toggleSend,
} from "../src/night-shift/model.ts";
import { ReviewSheet } from "../src/night-shift/ReviewSheet.tsx";
import { HABIT_DEFAULTS, MEMORY_CHOICE_DEFAULTS } from "../src/screens/onboarding/index.ts";
import { MemoryStep } from "../src/screens/onboarding/MemoryStep.tsx";
import { DailyPanel, windowLongEnough } from "../src/screens/settings/DailySection.tsx";
import { STORY_NOW, StoryWorld } from "../src/stories/harness.tsx";

/**
 * Night shift review (docs/design/night-shift-2026.md §3.2, §3.3, §5) against the mock Gateway:
 * the client shows only server item data, answers only an approval that matches what was ticked,
 * never sends from Select all, and never ticks what is stale.
 */

const I = NIGHT_IDS.items;

afterEach(() => tamperApprovals(null));

function items(): StagedAction[] {
  return nightShiftFixture().items;
}
const byId = (id: string) => items().find((i) => i.id === id) as StagedAction;

function setup(
  ui: ReactElement,
  edit?: (w: NightShiftWorld) => void,
  slots: { navigate?: (to: string) => void } = {},
) {
  let gateway: MockGateway | undefined;
  const user = userEvent.setup();
  render(
    <StoryWorld
      edit={(w) => {
        const ns = nightShiftFixture();
        edit?.(ns);
        w.nightShift = ns;
      }}
      onGateway={(g) => {
        gateway = g;
      }}
      slots={{ navigate: vi.fn(), ...slots }}
    >
      {ui}
    </StoryWorld>,
  );
  const calls = () => {
    const spy = vi.spyOn(gateway as MockGateway, "request");
    return spy;
  };
  return { user, gateway: () => gateway as MockGateway, calls };
}

const sheet = () => <ReviewSheet review="latest" onClose={() => {}} now={STORY_NOW} />;
const row = (id: string) => screen.findByTestId(`night-shift-row-${id}`);
const box = (el: HTMLElement, name: RegExp) => within(el).getByRole("checkbox", { name });
const checked = (el: HTMLElement) => el.getAttribute("aria-checked") === "true";
const disabled = (el: HTMLElement) =>
  el.getAttribute("aria-disabled") === "true" || el.hasAttribute("disabled");

describe("selection rules (pure)", () => {
  it("Select all ticks ready items and never a send", () => {
    const list = items();
    const sel = selectAll(EMPTY_SELECTION, list);
    expect(sel.ticked.has(I.reply)).toBe(true);
    expect(sel.ticked.has(I.event)).toBe(true);
    expect(sel.sends.size).toBe(0);
    expect(buildApply(sel, list).sends).toEqual([]);
    // Positive control: a send is only ever in the payload when it was ticked on its own.
    const withSend = toggleSend(sel, byId(I.reply));
    expect(buildApply(withSend, list).sends).toEqual([
      { itemId: I.reply, sendHash: byId(I.reply).send?.contentHash },
    ]);
  });

  it("starts with drafts ticked and no send", () => {
    const sel = seedSelection(items());
    expect(sel.ticked.has(I.reply)).toBe(true);
    expect(sel.ticked.has(I.event)).toBe(false);
    expect(sel.sends.size).toBe(0);
  });

  it("a stale item can't be ticked, by box or by Select all", () => {
    const list = items();
    expect(toggleItem(EMPTY_SELECTION, byId(I.stale)).ticked.size).toBe(0);
    expect(selectAll(EMPTY_SELECTION, list).ticked.has(I.stale)).toBe(false);
    // A refused item can't be ticked again either.
    const refused = markRefused(EMPTY_SELECTION, [{ itemId: I.event, reason: "nope" }]);
    expect(toggleItem(refused, byId(I.event)).ticked.size).toBe(0);
    // Positive control.
    expect(toggleItem(EMPTY_SELECTION, byId(I.event)).ticked.has(I.event)).toBe(true);
  });

  it("an item that goes stale after ticking drops out of the payload", () => {
    const list = items();
    const sel = toggleItem(EMPTY_SELECTION, byId(I.event));
    const later = list.map((i) => (i.id === I.event ? { ...i, status: "stale" as const } : i));
    expect(buildApply(sel, later).items).toEqual([]);
    expect(buildApply(sel, list).items.map((i) => i.itemId)).toEqual([I.event]);
  });

  it("a changed item (new binding hash) loses its tick instead of keeping the old hash", () => {
    const list = items();
    const sel = toggleItem(EMPTY_SELECTION, byId(I.event));
    const changed = list.map((i) =>
      i.id === I.event ? { ...i, bindingHash: "sha256:new" as const } : i,
    );
    expect(reconcile(sel, changed).ticked.size).toBe(0);
  });

  it("a send stays off until the draft is ticked and, when cut, until the full draft is opened", () => {
    const long = byId(I.long);
    const plain = byId(I.reply);
    // Not ticked: no send.
    expect(toggleSend(EMPTY_SELECTION, plain).sends.size).toBe(0);
    const ticked = toggleItem(EMPTY_SELECTION, long);
    expect(toggleSend(ticked, long).sends.size).toBe(0);
    const opened = markOpened(ticked, long);
    expect(toggleSend(opened, long).sends.get(I.long)).toBe(long.send?.contentHash);
    // Unticking the draft takes the send with it.
    const both = toggleSend(opened, long);
    expect(toggleItem(both, long).sends.size).toBe(0);
    // Not cut: opening is not needed.
    expect(toggleSend(toggleItem(EMPTY_SELECTION, plain), plain).sends.size).toBe(1);
    // Opened, then the draft changes: it must be opened again.
    const changed = { ...long, bindingHash: "sha256:changed" as const };
    expect(reconcile(both, [changed]).sends.size).toBe(0);
  });
});

describe("previews are plain text (pure)", () => {
  it("reads only the keys it knows and keeps markup as text", () => {
    const p = readPreview({
      rows: [
        {
          label: "Body",
          value: "<img src=x onerror=alert(1)>",
          html: "<b>x</b>",
          new_recipient: true,
        },
      ],
      truncated: true,
      reply_all: true,
      script: "<script>alert(1)</script>",
    });
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]?.value).toBe("<img src=x onerror=alert(1)>");
    expect(p.rows[0]).not.toHaveProperty("html");
    expect(p).not.toHaveProperty("script");
    expect(p.truncated && p.replyAll && p.rows[0]?.newRecipient).toBe(true);
    // Not an object, or a value that is not text: nothing.
    expect(readPreview("<b>x</b>").rows).toEqual([]);
    expect(readPreview({ rows: [{ label: { a: 1 }, value: { b: 2 } }] }).rows[0]?.value).toBeNull();
  });
});

describe("the approval check (pure)", () => {
  const payload = {
    items: [
      { itemId: "a", bindingHash: "h1" },
      { itemId: "b", bindingHash: "h2" },
    ],
    sends: [{ itemId: "a", sendHash: "s1" }],
  };
  const approval = (rows: unknown[], over: Partial<ApprovalRequest> = {}) =>
    ({
      id: "appr",
      kind: "staged_apply",
      status: "pending",
      details: { items: rows },
      ...over,
    }) as unknown as ApprovalRequest;
  const good = [
    { itemId: "a", bindingHash: "h1" },
    { itemId: "b", bindingHash: "h2" },
    { itemId: "a", sendHash: "s1" },
  ];

  it("accepts exactly the ticked set, in any order", () => {
    expect(checkApproval(approval(good), payload).ok).toBe(true);
    expect(checkApproval(approval([...good].reverse()), payload).ok).toBe(true);
  });

  it.each([
    ["an extra item", [...good, { itemId: "c", bindingHash: "h3" }]],
    ["a missing item", good.slice(1)],
    ["a missing send", good.slice(0, 2)],
    ["a different binding hash", [{ itemId: "a", bindingHash: "hX" }, ...good.slice(1)]],
    ["a different send hash", [...good.slice(0, 2), { itemId: "a", sendHash: "sX" }]],
    ["a send nobody ticked", [...good, { itemId: "b", sendHash: "s2" }]],
    ["a duplicated row", [...good, good[0]]],
    ["no hash at all", [{ itemId: "a" }, { itemId: "b" }, { itemId: "a", sendHash: "s1" }]],
  ])("refuses %s", (_name, rows) => {
    expect(checkApproval(approval(rows), payload).ok).toBe(false);
  });

  it("refuses another kind, a decided approval and a details without items", () => {
    expect(checkApproval(approval(good, { kind: "batch" }), payload).ok).toBe(false);
    expect(checkApproval(approval(good, { status: "approved" }), payload).ok).toBe(false);
    expect(checkApproval({ ...approval(good), details: {} } as ApprovalRequest, payload).ok).toBe(
      false,
    );
    expect(checkApproval(approval([{ itemId: 3 }]), payload).ok).toBe(false);
  });

  it("an undo is checked by item ids", () => {
    expect(checkApproval(approval([{ itemId: "a" }]), { undo: ["a"] }).ok).toBe(true);
    expect(checkApproval(approval([{ itemId: "a" }, { itemId: "z" }]), { undo: ["a"] }).ok).toBe(
      false,
    );
  });
});

describe("the review sheet", () => {
  it("shows New recipient and Reply all on a draft without opening it", async () => {
    setup(sheet());
    const long = await row(I.long);
    expect(within(long).getByText("New recipient")).toBeTruthy();
    expect(within(long).getByText("Reply all")).toBeTruthy();
    expect(within(long).getByText("Untrusted source")).toBeTruthy();
    // And no such badge on a plain draft.
    const plain = await row(I.reply);
    expect(within(plain).queryByText("New recipient")).toBeNull();
    expect(within(plain).queryByText("Reply all")).toBeNull();
  });

  it("Select all ticks no send, and Apply sends none", async () => {
    const { user, calls } = setup(sheet());
    await row(I.reply);
    const spy = calls();
    await user.click(screen.getByRole("button", { name: "Select all" }));
    for (const id of [I.reply, I.long]) {
      expect(checked(box(await row(id), /Send it too/))).toBe(false);
    }
    await user.click(screen.getByRole("button", { name: /^Apply selected/ }));
    await waitFor(() => expect(spy.mock.calls.some((c) => c[0] === "nightShift.apply")).toBe(true));
    const apply = spy.mock.calls.find((c) => c[0] === "nightShift.apply");
    const params = apply?.[1] as { items: unknown[]; sends: unknown[] };
    expect(params.sends).toEqual([]);
    expect(params.items.length).toBe(6);
    // The stale item is not among them.
    expect(JSON.stringify(params.items)).not.toContain(I.stale);
  });

  it("keeps Send it too off until the full draft is opened when the preview is cut", async () => {
    const { user, calls } = setup(sheet());
    const long = await row(I.long);
    const send = box(long, /Send it too/);
    expect(disabled(send)).toBe(true);
    // Drafts start ticked, and the send is still off: the preview is cut.
    expect(checked(box(long, /Select: Reply all/))).toBe(true);
    expect(within(long).getByText(/Show the full draft/)).toBeTruthy();
    // Unticking the draft turns it off for another reason.
    await user.click(box(long, /Select: Reply all/));
    expect(within(long).getByText(/Tick the draft first/)).toBeTruthy();
    await user.click(box(long, /Select: Reply all/));
    await user.click(within(long).getByRole("button", { name: "Show details" }));
    await waitFor(() => expect(disabled(box(long, /Send it too/))).toBe(false));
    const spy = calls();
    await user.click(box(long, /Send it too/));
    await user.click(screen.getByRole("button", { name: /^Apply selected/ }));
    await waitFor(() => expect(spy.mock.calls.some((c) => c[0] === "approvals.answer")).toBe(true));
    const apply = spy.mock.calls.find((c) => c[0] === "nightShift.apply")?.[1] as {
      sends: { itemId: string; sendHash: string }[];
    };
    expect(apply.sends).toEqual([{ itemId: I.long, sendHash: byId(I.long).send?.contentHash }]);
  });

  it("a stale item has no usable box and says why", async () => {
    setup(sheet());
    const stale = await row(I.stale);
    expect(disabled(box(stale, /Select: Reply to Priya/))).toBe(true);
    expect(within(stale).getByText("Stale")).toBeTruthy();
    expect(within(stale).getByText("A new message arrived in the thread.")).toBeTruthy();
  });

  it("renders previews as text, never HTML", async () => {
    const { user } = setup(sheet(), (w) => {
      const reply = w.items.find((i) => i.id === I.reply) as StagedAction;
      reply.summary = "Reply <b>now</b>";
      reply.preview = {
        rows: [
          {
            label: "Body",
            value: '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>',
          },
        ],
      };
    });
    const r = await row(I.reply);
    await user.click(within(r).getByRole("button", { name: "Show details" }));
    expect(within(r).getByText("Reply <b>now</b>")).toBeTruthy();
    expect(r.querySelector("img, script, b")).toBeNull();
    expect(r.textContent).toContain("<script>window.__pwned=2</script>");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("answers only the approval that matches, and shows only details.items", async () => {
    tamperApprovals((a) => ({
      ...a,
      details: {
        ...(a.details as object),
        // Keys a caller could put in: they must never show.
        note: "SECRET-NOTE <b>hi</b>",
        calls: ["INJECTED-CALL"],
      },
    }));
    const { user, calls } = setup(sheet());
    await row(I.event);
    const spy = calls();
    await user.click(box(await row(I.event), /Select: Move Focus time/));
    await user.click(screen.getByRole("button", { name: /^Apply selected/ }));
    const approved = await screen.findByTestId("night-shift-approved");
    expect(spy.mock.calls.some((c) => c[0] === "approvals.answer")).toBe(true);
    expect(approved.textContent).toContain("Move Focus time to 14:00");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("SECRET-NOTE");
    expect(text).not.toContain("INJECTED-CALL");
  });

  it.each([
    [
      "a swapped binding hash",
      (a: ApprovalRequest): ApprovalRequest => ({
        ...a,
        details: {
          items: (a.details as { items: Record<string, unknown>[] }).items.map((r) => ({
            ...r,
            bindingHash: "sha256:evil",
          })),
        },
      }),
    ],
    [
      "an extra item",
      (a: ApprovalRequest): ApprovalRequest => ({
        ...a,
        details: {
          items: [
            ...(a.details as { items: unknown[] }).items,
            { itemId: I.file, bindingHash: byId(I.file).bindingHash },
          ],
        },
      }),
    ],
    [
      "an extra send",
      (a: ApprovalRequest): ApprovalRequest => ({
        ...a,
        details: {
          items: [
            ...(a.details as { items: unknown[] }).items,
            { itemId: I.reply, sendHash: byId(I.reply).send?.contentHash },
          ],
        },
      }),
    ],
    ["no items", (a: ApprovalRequest): ApprovalRequest => ({ ...a, details: { items: [] } })],
  ])("refuses to answer an approval with %s", async (_name, tamper) => {
    tamperApprovals(tamper);
    const { user, calls, gateway } = setup(sheet());
    await row(I.event);
    const spy = calls();
    await user.click(box(await row(I.event), /Select: Move Focus time/));
    await user.click(screen.getByRole("button", { name: /^Apply selected/ }));
    const err = await screen.findByTestId("night-shift-error");
    expect(err.textContent).toMatch(/doesn’t match what you ticked/);
    expect(spy.mock.calls.some((c) => c[0] === "nightShift.apply")).toBe(true);
    expect(spy.mock.calls.some((c) => c[0] === "approvals.answer")).toBe(false);
    // Nothing ran: the item is still ready and the approval is still pending.
    expect(gateway().world.nightShift?.items.find((i) => i.id === I.event)?.status).toBe("ready");
    expect(gateway().world.approvals.find((a) => a.kind === "staged_apply")?.status).toBe(
      "pending",
    );
  });

  it("control: the same flow with an untouched approval is answered and applies", async () => {
    const { user, gateway } = setup(sheet());
    await row(I.event);
    await user.click(box(await row(I.event), /Select: Move Focus time/));
    await user.click(screen.getByRole("button", { name: /^Apply selected/ }));
    await waitFor(() =>
      expect(gateway().world.nightShift?.items.find((i) => i.id === I.event)?.status).toBe(
        "applied",
      ),
    );
  });

  it("shows applied and failed rows and offers Undo on an applied calendar change", async () => {
    const { user } = setup(sheet(), (w) => {
      w.failures = { [I.file]: "The folder is read only." };
    });
    await row(I.event);
    await user.click(box(await row(I.event), /Select: Move Focus time/));
    await user.click(box(await row(I.file), /Select: File invoice/));
    await user.click(screen.getByRole("button", { name: /^Apply selected/ }));
    const ev = await row(I.event);
    await waitFor(() => expect(within(ev).getByText("Applied")).toBeTruthy());
    expect(within(ev).getByRole("button", { name: "Undo" })).toBeTruthy();
    const file = await row(I.file);
    expect(within(file).getByText("Failed: The folder is read only.")).toBeTruthy();
    // No Undo on a failed item or a draft.
    expect(within(file).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(within(await row(I.reply)).queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("an uncertain item points to the app", async () => {
    const { user } = setup(sheet(), (w) => {
      w.uncertain = [I.event];
    });
    await row(I.event);
    await user.click(box(await row(I.event), /Select: Move Focus time/));
    await user.click(screen.getByRole("button", { name: /^Apply selected/ }));
    const ev = await row(I.event);
    await waitFor(() => expect(within(ev).getByText(/Check in Calendar/)).toBeTruthy());
  });

  it("an item the Gateway refuses is shown as not applied and can't be ticked again", async () => {
    const { user } = setup(sheet(), (w) => {
      w.refuse = { [I.event]: "That calendar changed." };
    });
    await row(I.event);
    await user.click(box(await row(I.event), /Select: Move Focus time/));
    await user.click(screen.getByRole("button", { name: /^Apply selected/ }));
    const ev = await row(I.event);
    await waitFor(() =>
      expect(within(ev).getByText("Not applied: That calendar changed.")).toBeTruthy(),
    );
    expect(disabled(box(ev, /Select: Move Focus time/))).toBe(true);
  });
});

describe("Home", () => {
  it("draws Prepared overnight right after Needs you, with counts, three lines and Review", async () => {
    const navigate = vi.fn();
    setup(<HomeScreen now={STORY_NOW} />, undefined, { navigate });
    const section = await screen.findByTestId("section-night-shift");
    expect(within(section).getByRole("heading", { name: "Prepared overnight" })).toBeTruthy();
    expect(section.textContent).toContain("3 reply drafts");
    expect(section.textContent).toContain("1 calendar fix");
    await waitFor(() => expect(within(section).getAllByRole("listitem").length).toBe(4));
    expect(within(section).getByText("+3 more")).toBeTruthy();
    const needs = await screen.findByTestId("section-needs-you");
    expect(needs.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(within(section).getByRole("button", { name: "Review" }));
    expect(navigate).toHaveBeenCalledWith(`/home?review=${NIGHT_IDS.night}`);
  });

  it("draws nothing when nothing is prepared or Night shift is off", async () => {
    setup(<HomeScreen now={STORY_NOW} />, (w) => {
      w.night = null;
      w.items = [];
      w.enabled = false;
    });
    await screen.findByTestId("section-needs-you");
    await waitFor(() => expect(screen.queryByTestId("section-night-shift")).toBeNull());
  });

  it("opens the review sheet at /home?review=<id>", async () => {
    setup(<HomeScreen now={STORY_NOW} review={NIGHT_IDS.night} />);
    expect(await screen.findByTestId("night-shift-review")).toBeTruthy();
    expect(await screen.findByTestId(`night-shift-row-${I.reply}`)).toBeTruthy();
  });
});

describe("settings", () => {
  it("needs a window of at least an hour, across midnight too", () => {
    expect(windowLongEnough("01:00", "05:00")).toBe(true);
    expect(windowLongEnough("01:00", "01:30")).toBe(false);
    expect(windowLongEnough("23:00", "02:00")).toBe(true);
    expect(windowLongEnough("05:00", "01:00")).toBe(true);
    expect(windowLongEnough("03:00", "03:00")).toBe(false);
  });

  it("is off by default, and turning it on records the consent time", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <StoryWorld>
        <DailyPanel values={{}} onChange={onChange} />
      </StoryWorld>,
    );
    const on = screen.getByRole("switch", { name: "Prepare things overnight" });
    expect(on.getAttribute("aria-checked")).toBe("false");
    // Everything below it is dimmed until it is on (positive control: the window is shown).
    expect(
      screen.getByRole("switch", { name: "Prepare reply drafts" }).getAttribute("aria-disabled"),
    ).toBe("true");
    await user.click(on);
    expect(onChange).toHaveBeenCalledWith("nightShift.enabled", true);
    expect(onChange).toHaveBeenCalledWith("nightShift.consentedAt", expect.any(String));
  });

  it("clamps the budget to 0.05 to 5", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <StoryWorld>
        <DailyPanel values={{ "nightShift.enabled": true }} onChange={onChange} />
      </StoryWorld>,
    );
    const budget = screen.getByLabelText("Budget per night (USD)");
    expect((budget as HTMLInputElement).value).toBe("0.5");
    await user.clear(budget);
    await user.type(budget, "99");
    await user.tab();
    expect(onChange).toHaveBeenCalledWith("nightShift.budgetUsd", 5);
  });

  it("onboarding offers it as an optional card that starts off", async () => {
    const onNightShiftChange = vi.fn();
    const user = userEvent.setup();
    const props = {
      persona: "Wren",
      habits: HABIT_DEFAULTS,
      onHabitsChange: () => {},
      memory: MEMORY_CHOICE_DEFAULTS,
      onMemoryChange: () => {},
    };
    const { unmount } = render(
      <StoryWorld>
        <MemoryStep {...props} nightShift={false} onNightShiftChange={onNightShiftChange} />
      </StoryWorld>,
    );
    const card = screen.getByTestId("onboarding-night-shift");
    expect(screen.getByText("Prepare things overnight?")).toBeTruthy();
    const sw = within(card).getByRole("switch", { name: "Prepare things overnight" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await user.click(sw);
    expect(onNightShiftChange).toHaveBeenCalledWith(true);
    unmount();
    // A host without the card draws none.
    render(
      <StoryWorld>
        <MemoryStep {...props} />
      </StoryWorld>,
    );
    expect(screen.queryByTestId("onboarding-night-shift")).toBeNull();
  });
});
