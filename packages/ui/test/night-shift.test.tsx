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
  sendBlock,
  toggleItem,
  toggleSend,
} from "../src/night-shift/model.ts";
import { ReviewSheet } from "../src/night-shift/ReviewSheet.tsx";
import { HABIT_DEFAULTS, MEMORY_CHOICE_DEFAULTS } from "../src/screens/onboarding/index.ts";
import { MemoryStep } from "../src/screens/onboarding/MemoryStep.tsx";
import {
  DailyPanel,
  runNowMessage,
  windowLongEnough,
} from "../src/screens/settings/DailySection.tsx";
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
          badge: "new_recipient",
        },
        // A flag the adapters do not write is not read.
        { label: "To", value: "x@example.com", new_recipient: true },
      ],
      truncated: true,
      script: "<script>alert(1)</script>",
    });
    expect(p.rows).toHaveLength(2);
    expect(p.rows[1]?.newRecipient).toBe(false);
    expect(p.rows[0]?.value).toBe("<img src=x onerror=alert(1)>");
    expect(p.rows[0]).not.toHaveProperty("html");
    expect(p).not.toHaveProperty("script");
    expect(p.truncated && p.rows[0]?.newRecipient).toBe(true);
    expect(p.replyAll).toBe(false);
    // A reply-all badge on any row marks the draft.
    expect(
      readPreview({ rows: [{ label: "Reply all", value: "yes", badge: "reply_all" }] }).replyAll,
    ).toBe(true);
    // Not an object, or a value that is not text: nothing.
    expect(readPreview("<b>x</b>").rows).toEqual([]);
    expect(readPreview({ rows: [{ label: { a: 1 }, value: { b: 2 } }] }).rows[0]?.value).toBe("");
  });
});

describe("the approval check (pure)", () => {
  const expected = {
    items: [
      { itemId: "a", bindingHash: "h1" },
      { itemId: "b", bindingHash: "h2" },
    ],
    sends: [{ itemId: "a", recipients: ["x@example.com", "Y@example.com"] }],
  };
  const approval = (rows: unknown[], over: Partial<ApprovalRequest> = {}) =>
    ({
      id: "appr",
      kind: "staged_apply",
      status: "pending",
      details: { items: rows },
      ...over,
    }) as unknown as ApprovalRequest;
  const draft = (itemId: string, bindingHash: string) => ({
    itemId,
    tool: "mail_draft",
    summary: `S ${itemId}`,
    bindingHash,
  });
  const sendRow = (itemId: string, send: unknown, extra: object = {}) => ({
    itemId: `${itemId}:send`,
    tool: "mail_send_draft",
    summary: "Send to x@example.com",
    // The broker's own staged-send binding: never compared with anything the client holds.
    bindingHash: "sha256:broker-owned",
    send,
    ...extra,
  });
  const good = [
    draft("a", "h1"),
    draft("b", "h2"),
    sendRow("a", { to: ["y@example.com", "x@example.com"] }),
  ];

  it("accepts exactly the ticked set, in any order", () => {
    expect(checkApproval(approval(good), expected).ok).toBe(true);
    expect(checkApproval(approval([...good].reverse()), expected).ok).toBe(true);
  });

  it.each([
    ["an extra item", [...good, draft("c", "h3")]],
    ["a missing item", good.slice(1)],
    ["a missing send", good.slice(0, 2)],
    ["a different binding hash", [draft("a", "hX"), ...good.slice(1)]],
    ["a send nobody ticked", [...good, sendRow("b", { to: ["x@example.com"] })]],
    ["a duplicated item row", [...good, good[0]]],
    ["a duplicated send row", [...good, good[2]]],
    ["an item row with no hash", [{ itemId: "a" }, ...good.slice(1)]],
    [
      "a send to other recipients",
      [...good.slice(0, 2), sendRow("a", { to: ["eve@example.com"] })],
    ],
    [
      "a send with an extra recipient",
      [
        ...good.slice(0, 2),
        sendRow("a", { to: ["x@example.com", "y@example.com", "eve@example.com"] }),
      ],
    ],
    ["a send row without a send", [...good.slice(0, 2), sendRow("a", undefined)]],
    ["a send with no recipients that was not withheld", [...good.slice(0, 2), sendRow("a", {})]],
    [
      "a send whose draft is not ticked",
      [good[1], sendRow("a", { to: ["x@example.com", "y@example.com"] })],
    ],
  ])("refuses %s", (_name, rows) => {
    expect(checkApproval(approval(rows), expected).ok).toBe(false);
  });

  it("accepts a withheld send that names nobody, only when the row says it is withheld", () => {
    const rows = (withheld: boolean) => [
      draft("a", "h1"),
      draft("b", "h2"),
      sendRow("a", {}, withheld ? { withheld: "messages" } : {}),
    ];
    expect(checkApproval(approval(rows(true)), expected).ok).toBe(true);
    expect(checkApproval(approval(rows(false)), expected).ok).toBe(false);
  });

  it("lets a refused item's rows be missing, but never lets a row be added", () => {
    const refused = new Set(["a"]);
    // The send for "a" was refused: the draft stays, the send row is gone.
    expect(checkApproval(approval(good.slice(0, 2)), { ...expected, refused }).ok).toBe(true);
    // The draft refused too: both rows gone.
    expect(checkApproval(approval([good[1]]), { ...expected, refused }).ok).toBe(true);
    // Missing without a refusal, and extras with one: no.
    expect(checkApproval(approval(good.slice(0, 2)), expected).ok).toBe(false);
    expect(checkApproval(approval([...good, draft("c", "h3")]), { ...expected, refused }).ok).toBe(
      false,
    );
    // The rows of an item that was refused must still be the ones the owner saw.
    expect(checkApproval(approval([draft("a", "hX"), good[1]]), { ...expected, refused }).ok).toBe(
      false,
    );
  });

  it("refuses another kind, a decided approval and a details without items", () => {
    expect(checkApproval(approval(good, { kind: "batch" }), expected).ok).toBe(false);
    expect(checkApproval(approval(good, { status: "approved" }), expected).ok).toBe(false);
    expect(checkApproval({ ...approval(good), details: {} } as ApprovalRequest, expected).ok).toBe(
      false,
    );
    expect(checkApproval(approval([{ itemId: 3 }]), expected).ok).toBe(false);
    expect(checkApproval(approval([]), { items: [], sends: [] }).ok).toBe(false);
  });

  it("an undo is checked by item ids", () => {
    expect(checkApproval(approval([{ itemId: "a" }]), { undo: ["a"] }).ok).toBe(true);
    expect(checkApproval(approval([{ itemId: "a" }, { itemId: "z" }]), { undo: ["a"] }).ok).toBe(
      false,
    );
  });
});

describe("who can send, who can tick (pure)", () => {
  const draftOf = (tool: string) => ({ ...byId(I.reply), tool });
  it("Send it too is for a new Apple Mail draft only", () => {
    const sel = toggleItem(EMPTY_SELECTION, byId(I.reply));
    expect(sendBlock(draftOf("mail_draft"), sel)).toBeNull();
    expect(sendBlock(draftOf("mcp__apple__mail_create_draft"), sel)).toBeNull();
    expect(sendBlock(draftOf("gmail_create_draft"), sel)).toBe("gmail");
    expect(sendBlock(draftOf("mcp__google__gmail_create_draft"), sel)).toBe("gmail");
    expect(sendBlock(draftOf("mail_reply_draft"), sel)).toBe("reply");
    expect(sendBlock(draftOf("calendar_update_event"), sel)).toBe("other");
    // And a tick on one of those never survives, even set directly.
    const gmail = draftOf("gmail_create_draft");
    expect(toggleSend(toggleItem(EMPTY_SELECTION, gmail), gmail).sends.size).toBe(0);
    expect(
      toggleSend(toggleItem(EMPTY_SELECTION, draftOf("mail_draft")), draftOf("mail_draft")).sends
        .size,
    ).toBe(1);
  });

  it("a withheld item or one mid-apply can't be ticked", () => {
    const withheld = { ...byId(I.event), withheld: "messages" as const };
    const applying = { ...byId(I.event), approvalId: "appr_1" };
    expect(toggleItem(EMPTY_SELECTION, withheld).ticked.size).toBe(0);
    expect(toggleItem(EMPTY_SELECTION, applying).ticked.size).toBe(0);
    expect(selectAll(EMPTY_SELECTION, [withheld, applying]).ticked.size).toBe(0);
    expect(toggleItem(EMPTY_SELECTION, byId(I.event)).ticked.size).toBe(1);
    // A tick on an item that is bound to an apply meanwhile is dropped from the payload.
    const sel = toggleItem(EMPTY_SELECTION, byId(I.event));
    expect(buildApply(sel, [applying]).items).toEqual([]);
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

  it("Send it too is off, with a reason, for a reply draft and a Gmail draft", async () => {
    setup(sheet(), (w) => {
      const reply = w.items.find((i) => i.id === I.reply) as StagedAction;
      reply.tool = "mcp__google__gmail_create_draft";
    });
    // Marco's is a reply draft, Dana's was made a Gmail draft.
    const marco = await row(I.plain);
    expect(disabled(box(marco, /Send it too/))).toBe(true);
    expect(within(marco).getByText(/reply’s saved draft can’t be checked/)).toBeTruthy();
    const dana = await row(I.reply);
    expect(disabled(box(dana, /Send it too/))).toBe(true);
    expect(within(dana).getByText(/Gmail draft can’t be checked/)).toBeTruthy();
    // Positive control: a new Apple Mail draft that is ticked and not cut can be sent.
    expect(disabled(box(await row(I.long), /Send it too/))).toBe(true);
    const draft = within(await row(I.long));
    expect(draft.getByText(/Show the full draft/)).toBeTruthy();
  });

  it("a send is its own row in the approval and is answered when it matches", async () => {
    const { user, calls, gateway } = setup(sheet());
    const dana = await row(I.reply);
    const spy = calls();
    await user.click(box(dana, /Send it too/));
    await user.click(screen.getByRole("button", { name: /^Apply selected/ }));
    await waitFor(() => expect(spy.mock.calls.some((c) => c[0] === "approvals.answer")).toBe(true));
    const approval = gateway().world.approvals.find((a) => a.kind === "staged_apply");
    const rows = (approval?.details as { items: { itemId: string }[] }).items.map((r) => r.itemId);
    expect(rows).toContain(`${I.reply}:send`);
    expect(rows).toContain(I.reply);
    const approved = await screen.findByTestId("night-shift-approved");
    expect(approved.textContent).toContain("Send to dana@example.com");
    // The send ran and is shown.
    await waitFor(() => expect(within(dana).getByText("Sent")).toBeTruthy());
  });

  it("an item from Messages is a localized line, can't be ticked, and shows no text", async () => {
    setup(sheet(), (w) => {
      const e = w.items.find((i) => i.id === I.event) as StagedAction;
      e.withheld = "messages";
      e.summary = "An item from your Messages. Open Psyche on this Mac to see it.";
      e.preview = null;
      e.why = "SECRET-WHY";
    });
    const r = await row(I.event);
    expect(
      within(r).getByText(/An item from your Messages\. Open Psyche on your computer/),
    ).toBeTruthy();
    expect(r.textContent).not.toContain("Open Psyche on this Mac");
    expect(r.textContent).not.toContain("SECRET-WHY");
    expect(disabled(within(r).getByRole("checkbox"))).toBe(true);
    expect(within(r).queryByRole("button", { name: "Show details" })).toBeNull();
    // Select all skips it.
    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(checked(within(r).getByRole("checkbox"))).toBe(false);
  });

  it("an item bound to an open apply is shown as being applied and can't be ticked", async () => {
    const { user } = setup(sheet(), (w) => {
      const e = w.items.find((i) => i.id === I.event) as StagedAction;
      e.approvalId = "appr_open";
    });
    const r = await row(I.event);
    expect(within(r).getByText("Being applied…")).toBeTruthy();
    expect(disabled(within(r).getByRole("checkbox"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(checked(within(r).getByRole("checkbox"))).toBe(false);
  });

  it("says undo refused and send before_effect in plain words, not the Gateway's text", async () => {
    setup(sheet(), (w) => {
      const e = w.items.find((i) => i.id === I.event) as StagedAction;
      e.status = "applied";
      e.appliedAt = "2026-10-18T09:00:00Z";
      e.result = { error: "undo refused: reminder changed (rem_123)" };
      const d = w.items.find((i) => i.id === I.reply) as StagedAction;
      d.status = "applied";
      d.result = { error: "send before_effect: binding_mismatch draft_42" };
      const l = w.items.find((i) => i.id === I.long) as StagedAction;
      l.status = "applied";
      l.result = { error: "send: helper timeout" };
    });
    const ev = await row(I.event);
    expect(within(ev).getByText("Not undone: it changed after it was applied.")).toBeTruthy();
    expect(ev.textContent).not.toContain("rem_123");
    const d = await row(I.reply);
    expect(within(d).getByText(/The draft was saved, but nothing was sent/)).toBeTruthy();
    expect(d.textContent).not.toContain("binding_mismatch");
    const l = await row(I.long);
    expect(within(l).getByText(/Not sure the send finished/)).toBeTruthy();
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
        kind: "mail",
        title: "Draft",
        truncated: false,
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
            {
              itemId: I.file,
              tool: "files_move",
              summary: "x",
              bindingHash: byId(I.file).bindingHash,
            },
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
            {
              itemId: `${I.reply}:send`,
              tool: "mail_send_draft",
              summary: "x",
              bindingHash: "sha256:broker",
              send: { to: byId(I.reply).send?.recipients },
            },
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

  it("says in plain words why Try it now did not start, with a fallback", () => {
    const say = (outcome: unknown) => runNowMessage({ started: false, outcome });
    expect(say("off")).toBe("Night shift is off.");
    expect(say("already")).toBe("It already ran tonight.");
    expect(say("skipped")).toBe("Skipped tonight.");
    expect(say("no_candidates")).toBe("Nothing to do tonight.");
    // An older Gateway sends no outcome, a newer one may send another: the generic line, no raw text.
    expect(say(undefined)).toBe("Couldn’t start it.");
    expect(say("something_new")).toBe("Couldn’t start it.");
  });
});
