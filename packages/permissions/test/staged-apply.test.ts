import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  MAX_STAGED_APPLY_CHILDREN,
  type PolicyCall,
  type StagedApplyChildInput,
  type StagedApplyRefusalReason,
} from "../src/index.ts";
import { CTX, call, DEVICE, makeBroker, memoryDb, recipient, sqliteBroker } from "./helpers.ts";

/**
 * `requestStagedApply` (docs/design/night-shift-2026.md §3.1-§3.3, §5.4): one approval for the
 * items the owner ticked in the morning review. Each child is decided again, a refused child
 * comes back in `refused[]`, the card is `staged_apply`, sensitive, once-only, and the minted
 * children carry the item id as their `toolCallId`.
 */

const flags = (id: string): PolicyCall =>
  call("mail_set_flags", "write", undefined, { params: { ids: [id], read: true } });

let n = 0;
const item = (
  c: PolicyCall,
  extra: Partial<StagedApplyChildInput> = {},
): StagedApplyChildInput => ({
  itemId: `item_${++n}`,
  call: c,
  summary: "Mark newsletter read",
  ...extra,
});

const send = (to = "dana@example.com"): PolicyCall =>
  call("email.send", "destructive", recipient(to), { kind: "send_email" });

function stage(
  h: ReturnType<typeof makeBroker>,
  children: StagedApplyChildInput[],
  taint = false,
  details?: Record<string, unknown>,
) {
  return h.broker.requestStagedApply({
    title: `Apply ${children.length} prepared changes`,
    children,
    context: { ...CTX, taint },
    requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
    surfaces: ["desktop", "telegram:42"],
    ...(details === undefined ? {} : { details: details as never }),
  });
}

async function answer(
  h: ReturnType<typeof makeBroker>,
  issued: Awaited<ReturnType<typeof stage>>,
  extra: { scope?: "once" | "always"; bulk?: true } = {},
) {
  h.clock.advance(500);
  return h.broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop ?? "",
    decision: "approve",
    scope: extra.scope ?? "once",
    decidedBy: DEVICE,
    ...(extra.bulk === undefined ? {} : { bulk: extra.bulk }),
  });
}

/** Stage one child next to a plain write; the plain write must stay, the child may be refused. */
async function verdict(child: StagedApplyChildInput) {
  const h = makeBroker();
  const ok = item(flags("keep"));
  const issued = await stage(h, [ok, child]);
  return { refused: issued.refused, approval: issued.approval, okId: ok.itemId };
}

interface Row {
  name: string;
  child: () => StagedApplyChildInput;
  reason: StagedApplyRefusalReason | StagedApplyRefusalReason[];
}

const reasons = (r: Row["reason"]) => (Array.isArray(r) ? r : [r]);

describe("requestStagedApply: refused children (§3.1, §3.2, §5.4)", () => {
  const REFUSED: Row[] = [
    // money-intent: tool name, summary and string args
    {
      name: "a payment tool",
      child: () =>
        item(call("link.pay", "write", { kind: "origin", value: "https://shop.example" })),
      reason: ["money_intent", "financial", "denied"],
    },
    {
      name: "a money tool name (sell_stock)",
      child: () => item(call("sell_stock", "write")),
      reason: "money_intent",
    },
    {
      name: "a money tool name behind a connector prefix (stripe.refund)",
      child: () => item(call("stripe.refund", "write")),
      reason: "money_intent",
    },
    {
      name: "a payment summary on a plain write",
      child: () => item(flags("m1"), { summary: "Pay $50 to Dana" }),
      reason: "money_intent",
    },
    {
      name: "a money amount in a string arg",
      child: () =>
        item(call("mail_set_flags", "write", undefined, { params: { note: "Send $250 to Bob" } })),
      reason: "money_intent",
    },
    {
      name: "a financial side effect",
      child: () => item(call("mail_set_flags", "financial")),
      reason: ["financial", "denied", "money_intent"],
    },
    // purchase and every AUTH_KINDS kind, declared on a write call
    ...(
      [
        "purchase",
        "credential_fill",
        "exec_host",
        "pairing",
        "policy_change",
        "apple_script",
      ] as const
    ).map(
      (kind): Row => ({
        name: `kind ${kind}`,
        child: () => item(call("mail_set_flags", "write", undefined, { kind })),
        reason: ["purchase", "authentication", "denied", "financial"],
      }),
    ),
    // every other device-only kind
    ...(
      ["skill_install", "folder_access", "separate_desktop_share", "permission_request"] as const
    ).map(
      (kind): Row => ({
        name: `device-only kind ${kind}`,
        child: () => item(call("mail_set_flags", "write", undefined, { kind })),
        reason: ["device_only_kind", "denied"],
      }),
    ),
    {
      name: "a nested batch",
      child: () => item(call("mail_set_flags", "write", undefined, { kind: "batch" })),
      reason: "nested_approval",
    },
    {
      name: "a nested staged apply",
      child: () => item(call("mail_set_flags", "write", undefined, { kind: "staged_apply" })),
      reason: "nested_approval",
    },
    // sends: §3.2
    {
      name: "a send that is not marked explicit",
      child: () => item(send(), { recipients: ["dana@example.com"] }),
      reason: "send_not_explicit",
    },
    {
      name: "an explicit send with no recipients",
      child: () => item(send(), { explicitSend: true }),
      reason: "send_not_explicit",
    },
    {
      name: "an explicit send with an empty recipient list",
      child: () => item(send(), { explicitSend: true, recipients: [] }),
      reason: "send_not_explicit",
    },
    {
      name: "an explicit send with a blank recipient",
      child: () => item(send(), { explicitSend: true, recipients: ["dana@example.com", " "] }),
      reason: "send_not_explicit",
    },
    {
      name: "explicitSend false",
      child: () => item(send(), { explicitSend: false, recipients: ["dana@example.com"] }),
      reason: "send_not_explicit",
    },
    {
      name: "a send relabelled as a file write",
      child: () =>
        item(
          call("email.send", "destructive", recipient("dana@example.com"), { kind: "file_write" }),
          {
            recipients: ["dana@example.com"],
          },
        ),
      reason: ["send_not_explicit", "destructive", "denied"],
    },
    {
      name: "a send dressed as an undo",
      child: () =>
        item(send(), { explicitSend: true, recipients: ["a@x.org"], undo: { createdId: "evt_1" } }),
      reason: "send_not_explicit",
    },
    // destructive: §5.4
    {
      name: "a delete",
      child: () => item(call("mail_delete", "destructive")),
      reason: "destructive",
    },
    {
      name: "a write the broker's floor lifts to a delete",
      child: () => item(call("files.delete_item", "write")),
      reason: "destructive",
    },
    {
      name: "a calendar delete that is not an undo",
      child: () =>
        item(call("calendar_delete_event", "destructive", undefined, { params: { id: "evt_1" } })),
      reason: "destructive",
    },
    {
      name: "an undo whose created id is not in the call",
      child: () =>
        item(call("calendar_delete_event", "destructive", undefined, { params: { id: "evt_9" } }), {
          undo: { createdId: "evt_1" },
        }),
      reason: "undo_unbound",
    },
    {
      name: "an undo with an empty created id",
      child: () =>
        item(call("calendar_delete_event", "destructive", undefined, { params: { id: "" } }), {
          undo: { createdId: "" },
        }),
      reason: "undo_unbound",
    },
    {
      name: "an undo on a tool that is not a Night shift delete",
      child: () =>
        item(call("mail_delete", "destructive", undefined, { params: { id: "evt_1" } }), {
          undo: { createdId: "evt_1" },
        }),
      reason: "undo_unbound",
    },
    {
      name: "an undo that deletes a file",
      child: () =>
        item(call("delete_file", "destructive", undefined, { params: { path: "evt_1" } }), {
          undo: { createdId: "evt_1" },
        }),
      reason: ["undo_unbound", "denied", "device_only_kind"],
    },
    // read and none are not changes
    {
      name: "a read",
      child: () => item(call("mail_search", "read")),
      reason: "not_write",
    },
    // ids
    {
      name: "an empty item id",
      child: () => item(flags("m1"), { itemId: "" }),
      reason: "invalid_item",
    },
    {
      name: "an over-long item id",
      child: () => item(flags("m1"), { itemId: "x".repeat(200) }),
      reason: "invalid_item",
    },
  ];

  it.each(REFUSED)("refuses $name and still approves the rest", async (row) => {
    const child = row.child();
    const v = await verdict(child);
    expect(v.refused).toHaveLength(1);
    const r = v.refused[0];
    expect(reasons(row.reason)).toContain(r?.reason);
    expect(r).toMatchObject({ itemId: child.itemId, index: 1 });
    // The set is still approvable without it.
    expect(v.approval.status).toBe("pending");
    expect(
      (v.approval.details as { items: { itemId: string }[] }).items.map((i) => i.itemId),
    ).toEqual([v.okId]);
  });

  it("a duplicate item id is refused, the first stays", async () => {
    const h = makeBroker();
    const a = item(flags("m1"));
    const issued = await stage(h, [a, { ...item(flags("m2")), itemId: a.itemId }]);
    expect(issued.refused).toMatchObject([
      { itemId: a.itemId, index: 1, reason: "duplicate_item" },
    ]);
  });

  it("refuses a denied call (a prohibition) and names it", async () => {
    const h = makeBroker();
    const issued = await stage(h, [
      item(flags("m1")),
      item(call("credentials.request", "write", undefined, { kind: "credential_fill" })),
    ]);
    expect(issued.refused).toHaveLength(1);
  });

  it("a set where nothing can be applied issues no approval", async () => {
    const h = makeBroker();
    const del = item(call("mail_delete", "destructive"));
    await expect(stage(h, [del])).rejects.toMatchObject({
      code: "policy_denied",
      details: { reason: "all_refused", refused: [{ itemId: del.itemId, reason: "destructive" }] },
    });
  });

  it("a money-looking summary and a money-looking arg are refused in every child position", async () => {
    const h = makeBroker();
    const kids = [
      item(flags("m1")),
      item(flags("m2"), { summary: "Place bid on the lamp" }),
      item(call("mail_set_flags", "write", undefined, { params: { subject: "Send $10 now" } })),
      item(flags("m3")),
    ];
    const issued = await stage(h, kids);
    expect(issued.refused.map((r) => r.index)).toEqual([1, 2]);
  });
});

describe("requestStagedApply: near-misses that must be allowed", () => {
  const ALLOWED: { name: string; child: () => StagedApplyChildInput }[] = [
    { name: "a plain write", child: () => item(flags("m1")) },
    {
      name: "'transfer' and 'card' in an ordinary summary",
      child: () => item(flags("m1"), { summary: "Move the transfer notes and the card list" }),
    },
    {
      name: "'checkout' as a git word in a param",
      child: () =>
        item(call("mail_set_flags", "write", undefined, { params: { note: "git checkout main" } })),
    },
    {
      name: "a reminder about a person",
      child: () => item(call("reminders_create", "write"), { summary: "Reminder: call Dana at 5" }),
    },
    {
      name: "an explicit send with recipients",
      child: () => item(send(), { explicitSend: true, recipients: ["dana@example.com"] }),
    },
    {
      name: "an explicit send to two recipients",
      child: () => item(send(), { explicitSend: true, recipients: ["a@x.org", "b@x.org"] }),
    },
    {
      name: "an undo delete of an event Night shift created",
      child: () =>
        item(call("calendar_delete_event", "destructive", undefined, { params: { id: "evt_1" } }), {
          undo: { createdId: "evt_1" },
        }),
    },
    {
      name: "an undo delete of a reminder Night shift created",
      child: () =>
        item(call("reminders_delete", "destructive", undefined, { params: { id: "rem_7" } }), {
          undo: { createdId: "rem_7" },
        }),
    },
    {
      name: "an undo delete through a connector prefix",
      child: () =>
        item(
          call("apple.calendar_delete_event", "destructive", undefined, {
            params: { id: "evt_2" },
          }),
          { undo: { createdId: "evt_2" } },
        ),
    },
  ];

  it.each(ALLOWED)("allows $name", async (row) => {
    const h = makeBroker();
    const child = row.child();
    const issued = await stage(h, [child]);
    expect(issued.refused).toEqual([]);
    expect(issued.approval.status).toBe("pending");
  });
});

describe("requestStagedApply: the approval", () => {
  it("is a sensitive, once-only, 10 minute card that needs no presence", async () => {
    const h = makeBroker();
    const issued = await stage(h, [item(flags("m1")), item(flags("m2"))]);
    const a = issued.approval;
    expect(a).toMatchObject({
      kind: "staged_apply",
      riskClass: "sensitive",
      scopesOffered: ["once"],
      requiresAuthentication: false,
      status: "pending",
    });
    expect(Date.parse(a.expiresAt) - Date.parse(a.requestedAt)).toBe(10 * 60_000);
    expect(a.details).toMatchObject({ count: 2 });
  });

  it("lists every child's item id, tool and binding hash in details.items, in order", async () => {
    const h = makeBroker();
    const kids = [item(flags("m1")), item(flags("m2"))];
    const issued = await stage(h, kids, false, { items: [{ itemId: "forged", bindingHash: "x" }] });
    const items = (issued.approval.details as { items: Record<string, string>[] }).items;
    expect(items.map((i) => i.itemId)).toEqual(kids.map((k) => k.itemId));
    expect(items.every((i) => typeof i.bindingHash === "string" && i.bindingHash.length > 8)).toBe(
      true,
    );
    expect(items.map((i) => i.tool)).toEqual(["mail_set_flags", "mail_set_flags"]);
  });

  it("binds the ordered child hashes: the same calls in another order are another approval", async () => {
    const h = makeBroker();
    const a = await stage(h, [item(flags("m1")), item(flags("m2"))]);
    const b = await stage(h, [item(flags("m2")), item(flags("m1"))]);
    expect(a.approval.bindingHash).not.toBe(b.approval.bindingHash);
  });

  it("offers `once` only: an always answer is refused and no grant is created", async () => {
    const h = makeBroker();
    const issued = await stage(h, [item(flags("m1"))]);
    h.clock.advance(500);
    await expect(
      h.broker.answer({
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop ?? "",
        decision: "approve",
        scope: "always",
        decidedBy: DEVICE,
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    const done = await answer(h, issued);
    expect(done.status).toBe("approved");
    expect(done.scopeGranted).toBe("once");
    expect(done.grantId).toBeNull();
  });

  it("is never part of 'Approve all routine'", async () => {
    const h = makeBroker();
    const issued = await stage(h, [item(flags("m1"))]);
    await expect(answer(h, issued, { bulk: true })).rejects.toMatchObject({
      code: "invalid_params",
      details: { reason: "not_routine" },
    });
    // The positive control: the same card answered normally is approved.
    expect((await answer(h, issued)).status).toBe("approved");
  });

  it("a set with a send is device-only, destructive, and never reaches a chat", async () => {
    const h = makeBroker();
    const issued = await stage(h, [
      item(flags("m1")),
      item(send(), { explicitSend: true, recipients: ["dana@example.com", "lee@example.com"] }),
    ]);
    const a = issued.approval;
    expect(a).toMatchObject({
      deviceOnly: true,
      sideEffect: "destructive",
      requiresAuthentication: false,
      riskClass: "sensitive",
    });
    expect(a.surfaces.some((s) => s.startsWith("telegram"))).toBe(false);
    const items = (a.details as { items: { send?: { to: string[] } }[] }).items;
    expect(items[0]?.send).toBeUndefined();
    expect(items[1]?.send).toEqual({ to: ["dana@example.com", "lee@example.com"] });
  });

  it("a set of writes only is not device-only (positive control for the send case)", async () => {
    const h = makeBroker();
    const a = (await stage(h, [item(flags("m1"))])).approval;
    expect(a.deviceOnly).toBe(false);
    expect(a.sideEffect).toBe("write");
  });

  it("an undo delete makes the set device-only", async () => {
    const h = makeBroker();
    const a = (
      await stage(h, [
        item(call("calendar_delete_event", "destructive", undefined, { params: { id: "evt_1" } }), {
          undo: { createdId: "evt_1" },
        }),
      ])
    ).approval;
    expect(a.deviceOnly).toBe(true);
    expect(a.surfaces.some((s) => s.startsWith("telegram"))).toBe(false);
  });

  it("carries taint to the card and every child", async () => {
    const h = makeBroker();
    const issued = await h.broker.requestStagedApply({
      title: "Apply 1 prepared change",
      children: [item(flags("m1"))],
      context: { ...CTX, taint: true },
      requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
      surfaces: ["desktop"],
      taintSources: [{ sourceKind: "email", sender: "shop@example.com" }],
    });
    expect(issued.approval.taint).toBe(true);
    await answer(h, issued);
    const kids = await h.broker.batchChildren(issued.approval.id);
    expect(kids.every((c) => c.approval.taint)).toBe(true);
  });

  it("holds 1 to 50 items", async () => {
    const h = makeBroker();
    expect(MAX_STAGED_APPLY_CHILDREN).toBe(50);
    await expect(stage(h, [])).rejects.toMatchObject({ code: "invalid_params" });
    const fifty = Array.from({ length: 50 }, (_, i) => item(flags(`m${i}`)));
    expect((await stage(h, fifty)).refused).toEqual([]);
    const fiftyOne = Array.from({ length: 51 }, (_, i) => item(flags(`n${i}`)));
    await expect(stage(h, fiftyOne)).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("requestStagedApply: minted children", () => {
  it("mints one approved once-only child per kept item, toolCallId = item id, consumed once", async () => {
    const h = makeBroker();
    const kids = [item(flags("m1")), item(flags("m2")), item(call("mail_delete", "destructive"))];
    const issued = await stage(h, kids);
    expect(issued.refused.map((r) => r.itemId)).toEqual([kids[2]?.itemId]);
    expect(await h.broker.batchChildren(issued.approval.id)).toEqual([]);
    expect((await answer(h, issued)).status).toBe("approved");
    const children = await h.broker.batchChildren(issued.approval.id);
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.approval.requestedBy.toolCallId)).toEqual([
      kids[0]?.itemId,
      kids[1]?.itemId,
    ]);
    expect(
      children.every(
        (c) =>
          c.approval.status === "approved" &&
          c.approval.scopeGranted === "once" &&
          c.approval.surfaces.length === 0 &&
          c.approval.requiresAuthentication === false,
      ),
    ).toBe(true);
    const [c1, c2] = children;
    expect(
      await h.broker.verifyBinding(c1?.approval.id ?? "", c2?.approval.bindingHash ?? ""),
    ).toMatchObject({ ok: false, reason: "binding_mismatch" });
    expect(
      await h.broker.verifyBinding(c1?.approval.id ?? "", c1?.approval.bindingHash ?? ""),
    ).toMatchObject({ ok: true });
    expect(
      await h.broker.verifyBinding(c1?.approval.id ?? "", c1?.approval.bindingHash ?? ""),
    ).toMatchObject({ ok: false, reason: "consumed" });
  });

  it("a denied approval mints nothing", async () => {
    const h = makeBroker();
    const issued = await stage(h, [item(flags("m1"))]);
    h.clock.advance(500);
    const r = await h.broker.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens.desktop ?? "",
      decision: "deny",
      scope: "once",
      decidedBy: DEVICE,
    });
    expect(r.status).toBe("denied");
    expect(await h.broker.batchChildren(issued.approval.id)).toEqual([]);
  });

  it("an expired approval can't be answered and mints nothing", async () => {
    const h = makeBroker();
    const issued = await stage(h, [item(flags("m1"))]);
    h.clock.advance(10 * 60_000 + 1000);
    await expect(answer(h, issued)).rejects.toBeDefined();
    expect(await h.broker.batchChildren(issued.approval.id)).toEqual([]);
  });

  it("survives a restart on real SQLite: the children keep their item ids", async () => {
    const db = memoryDb();
    const clock = new FakeClock();
    const b1 = sqliteBroker(db, clock);
    const kids = [item(flags("m1")), item(flags("m2"))];
    const issued = await b1.requestStagedApply({
      title: "Apply 2 prepared changes",
      children: kids,
      context: CTX,
      requestedBy: { runId: CTX.runId, taskId: null, threadId: CTX.threadId },
      surfaces: ["desktop"],
    });
    clock.advance(500);
    await b1.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens.desktop ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: DEVICE,
    });
    const b2 = sqliteBroker(db, clock);
    const children = await b2.batchChildren(issued.approval.id);
    expect(children.map((c) => c.approval.requestedBy.toolCallId)).toEqual(
      kids.map((k) => k.itemId),
    );
    expect(children.every((c) => c.approval.status === "approved")).toBe(true);
  });
});
