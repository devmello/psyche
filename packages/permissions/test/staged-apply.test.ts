import { sha256 } from "@psyche/audit";
import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  MAX_STAGED_APPLY_CHILDREN,
  type PolicyCall,
  type StagedApplyChildInput,
  type StagedApplyRefusalReason,
} from "../src/index.ts";
import {
  CTX,
  call,
  DEVICE,
  makeBroker,
  memoryDb,
  OWNER,
  recipient,
  sqliteBroker,
} from "./helpers.ts";

/**
 * `requestStagedApply` (docs/design/night-shift-2026.md §3.1-§3.3, §5.4): one approval for the
 * items the owner ticked in the morning review. Each child is decided again, a refused child
 * comes back in `refused[]`, the card is `staged_apply`, sensitive, once-only, and the minted
 * children carry the item id as their `toolCallId`.
 */

const flags = (id: string): PolicyCall =>
  call("mail_set_flags", "write", undefined, { params: { ids: [id], read: true } });

const IDS: ReadonlySet<string> = new Set(["apple", "google"]);

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

/** A call whose params are exactly what the tool takes (the `call` helper adds `tool` and `target`). */
const exact = (
  tool: string,
  sideEffect: PolicyCall["sideEffect"],
  params: Record<string, unknown>,
  extra: Partial<PolicyCall> = {},
): PolicyCall => ({
  tool,
  sideEffect,
  params,
  paramsHash: sha256(JSON.stringify(params)),
  ...extra,
});

const send = (to: string | string[] = "dana@example.com", extra: Record<string, unknown> = {}) => {
  const list = Array.isArray(to) ? to : [to];
  return call("gmail_send", "destructive", recipient(list[0] ?? ""), {
    kind: "send_email",
    params: { to: list, subject: "Re: lunch", ...extra },
  });
};

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
    surfaces: ["desktop", "oldchat:42"],
    connectorIds: IDS,
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
    ...(["mail_reply_draft", "calendar_create_event"] as const).flatMap((tool) =>
      ["Pay rent", "Pay the plumber $120"].map(
        (text): Row => ({
          name: `"${text}" in ${tool} (only reminders may carry money words)`,
          child: () => item(exact(tool, "write", { title: text, body: text }), { summary: text }),
          reason: "money_intent",
        }),
      ),
    ),
    {
      name: "a reminder whose tool name is money-like",
      child: () => item(exact("reminders_create_refund", "write", { title: "Pay rent" })),
      reason: "money_intent",
    },
    ...(
      [
        ["mcp__evil__gmail_send", ["a@x.com"]],
        ["mcp__stripe__mail_send_draft", ["a@x.com"]],
        ["mcp__apple__mail_send", ["a@x.com"]],
      ] as const
    ).map(
      ([tool, to]): Row => ({
        name: `a send as ${tool} (id not live, or not a send tool of that id)`,
        child: () =>
          item(
            exact(
              tool,
              "destructive",
              { to: [...to] },
              { kind: "send_email", target: recipient(to[0]) },
            ),
            {
              explicitSend: true,
              recipients: [...to],
            },
          ),
        reason: ["send_not_explicit", "destructive", "denied"],
      }),
    ),
    {
      name: "an undo through an mcp tool of an id that is not live",
      child: () =>
        item(exact("mcp__evil__calendar_delete_event", "destructive", { id: "evt_1" }), {
          undo: { createdId: "evt_1" },
        }),
      reason: ["undo_unbound", "destructive", "denied"],
    },
    {
      name: "a reminder of an mcp id that is not live is scanned (mcp__stripe__reminders_create)",
      child: () =>
        item(exact("mcp__stripe__reminders_create", "write", { title: "Pay rent" }), {
          summary: "Pay rent",
        }),
      reason: "money_intent",
    },
    {
      name: "a prefixed reminder tool is scanned like any other (stripe.reminders_create)",
      child: () =>
        item(exact("stripe.reminders_create", "write", { title: "Pay rent" }), {
          summary: "Pay rent",
        }),
      reason: "money_intent",
    },
    {
      name: "a direct mail_send (no saved draft) is not on the send allowlist",
      child: () =>
        item(exact("mail_send", "destructive", { to: ["a@x.com"] }, { kind: "send_email" }), {
          explicitSend: true,
          recipients: ["a@x.com"],
        }),
      reason: ["send_not_explicit", "destructive", "denied"],
    },
    {
      name: "an undo with a prototype key as a field",
      child: () =>
        item(
          exact(
            "calendar_delete_event",
            "destructive",
            JSON.parse('{"id":"evt_1","__proto__":"x"}'),
          ),
          { undo: { createdId: "evt_1" } },
        ),
      reason: "undo_unbound",
    },
    {
      name: "an undo with a constructor field",
      child: () =>
        item(exact("reminders_delete", "destructive", { id: "rem_1", constructor: "x" }), {
          undo: { createdId: "rem_1" },
        }),
      reason: "undo_unbound",
    },
    {
      name: "an undo whose item-kind target is another event",
      child: () =>
        item(
          exact(
            "calendar_delete_event",
            "destructive",
            { id: "evt_1" },
            { target: { kind: "origin", value: "evt_2" } },
          ),
          { undo: { createdId: "evt_1" } },
        ),
      reason: ["undo_unbound", "denied"],
    },
    {
      name: "an undo with only an account target and no id field",
      child: () =>
        item(
          exact(
            "calendar_delete_event",
            "destructive",
            {},
            { target: { kind: "account", value: "apple.calendar" } },
          ),
          { undo: { createdId: "apple.calendar" } },
        ),
      reason: "undo_unbound",
    },
    {
      name: "a reminder-shaped tool through MCP",
      child: () =>
        item(exact("mcp__x__reminders_create", "write", { title: "Pay rent" }), {
          summary: "Pay rent",
        }),
      reason: ["money_intent", "denied", "device_only_kind"],
    },
    {
      name: "a reminder item with a financial side effect",
      child: () =>
        item(exact("reminders_create", "financial", { title: "Pay rent" }), {
          summary: "Pay rent",
        }),
      reason: ["financial", "denied", "money_intent"],
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
          call("gmail_send", "destructive", recipient("dana@example.com"), {
            kind: "file_write",
            params: { to: ["dana@example.com"] },
          }),
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
      child: () => item(exact("calendar_delete_event", "destructive", { id: "evt_1" })),
      reason: "destructive",
    },
    {
      name: "an undo whose created id is not in the call",
      child: () =>
        item(exact("calendar_delete_event", "destructive", { id: "evt_9" }), {
          undo: { createdId: "evt_1" },
        }),
      reason: "undo_unbound",
    },
    {
      name: "an undo with an empty created id",
      child: () =>
        item(exact("calendar_delete_event", "destructive", { id: "" }), {
          undo: { createdId: "" },
        }),
      reason: "undo_unbound",
    },
    {
      name: "an undo on a tool that is not a Night shift delete",
      child: () =>
        item(exact("mail_delete", "destructive", { id: "evt_1" }), {
          undo: { createdId: "evt_1" },
        }),
      reason: "undo_unbound",
    },
    {
      name: "an undo that deletes a file",
      child: () =>
        item(exact("delete_file", "destructive", { path: "evt_1" }), {
          undo: { createdId: "evt_1" },
        }),
      reason: ["undo_unbound", "denied", "device_only_kind"],
    },
    // §3.2 review round 1: a label never makes a tool a send
    ...(
      [
        ["mail_delete", "destructive"],
        ["node.shortcuts.run", "destructive"],
        ["calendar_delete_event", "destructive"],
        ["node.files.trash", "destructive"],
        ["gmail_trash", "destructive"],
        ["mail_set_flags", "write"],
      ] as const
    ).map(
      ([tool, se]): Row => ({
        name: `${tool} labelled send_email with explicitSend`,
        child: () =>
          item(
            exact(
              tool,
              se,
              { id: "evt_1", to: ["a@x.org"] },
              {
                kind: "send_email",
                target: recipient("a@x.org"),
              },
            ),
            { explicitSend: true, recipients: ["a@x.org"] },
          ),
        reason: [
          "destructive",
          "send_not_explicit",
          "denied",
          "device_only_kind",
          "authentication",
        ],
      }),
    ),
    ...(["message_send", "send_email"] as const).map(
      (kind): Row => ({
        name: `a write on a non-send tool labelled ${kind}`,
        child: () =>
          item(exact("mail_set_flags", "write", { ids: ["m1"] }, { kind }), {
            explicitSend: true,
            recipients: ["a@x.org"],
          }),
        reason: ["send_not_explicit", "denied"],
      }),
    ),
    {
      name: "a send tool labelled message_send",
      child: () =>
        item(exact("gmail_send", "destructive", { to: ["a@x.org"] }, { kind: "message_send" }), {
          explicitSend: true,
          recipients: ["a@x.org"],
        }),
      reason: ["send_not_explicit", "denied"],
    },
    {
      name: "a send whose given recipients differ from the call's own",
      child: () =>
        item(send(["a@x.org", "b@x.org"]), { explicitSend: true, recipients: ["a@x.org"] }),
      reason: "send_not_explicit",
    },
    {
      name: "a send whose given recipients name someone the call does not",
      child: () =>
        item(send("a@x.org"), { explicitSend: true, recipients: ["a@x.org", "c@x.org"] }),
      reason: "send_not_explicit",
    },
    {
      name: "a send with a hidden bcc the caller left out",
      child: () =>
        item(send("a@x.org", { bcc: ["boss@x.org"] }), {
          explicitSend: true,
          recipients: ["a@x.org"],
        }),
      reason: "send_not_explicit",
    },
    {
      name: "a send with no recipient in the call itself",
      child: () =>
        item(exact("gmail_send", "destructive", { subject: "x" }, { kind: "send_email" }), {
          explicitSend: true,
          recipients: ["a@x.org"],
        }),
      reason: "send_not_explicit",
    },
    // §5.4 review round 1: the undo is bound to the tool's own id field, nothing else
    {
      name: "an undo whose created id is the calendar id, not the event id (probe: primary)",
      child: () =>
        item(
          exact("calendar_delete_event", "destructive", { id: "evt_9", calendarId: "primary" }),
          {
            undo: { createdId: "primary" },
          },
        ),
      reason: "undo_unbound",
    },
    {
      name: "an undo whose created id is only a key name",
      child: () =>
        item(exact("calendar_delete_event", "destructive", { id: "evt_9", evt_1: true }), {
          undo: { createdId: "evt_1" },
        }),
      reason: "undo_unbound",
    },
    {
      name: "an undo whose created id appears in a note field",
      child: () =>
        item(exact("calendar_delete_event", "destructive", { id: "evt_9", note: "evt_1" }), {
          undo: { createdId: "evt_1" },
        }),
      reason: "undo_unbound",
    },
    {
      name: "an undo with span future",
      child: () =>
        item(exact("calendar_delete_event", "destructive", { id: "evt_1", span: "future" }), {
          undo: { createdId: "evt_1" },
        }),
      reason: "undo_unbound",
    },
    {
      name: "an undo that notifies attendees",
      child: () =>
        item(
          exact("calendar_delete_event", "destructive", { eventId: "evt_1", sendUpdates: "all" }),
          {
            undo: { createdId: "evt_1" },
          },
        ),
      reason: "undo_unbound",
    },
    {
      name: "an undo naming a calendar the created event is not known to be in",
      child: () =>
        item(
          exact("calendar_delete_event", "destructive", { eventId: "evt_1", calendarId: "work" }),
          {
            undo: { createdId: "evt_1" },
          },
        ),
      reason: "undo_unbound",
    },
    {
      name: "an undo naming another calendar than the stored one",
      child: () =>
        item(
          exact("calendar_delete_event", "destructive", { eventId: "evt_1", calendarId: "work" }),
          {
            undo: { createdId: "evt_1", calendarId: "home" },
          },
        ),
      reason: "undo_unbound",
    },
    {
      name: "an undo with both id fields, one of them another event",
      child: () =>
        item(exact("calendar_delete_event", "destructive", { id: "evt_1", eventId: "evt_2" }), {
          undo: { createdId: "evt_1" },
        }),
      reason: "undo_unbound",
    },
    {
      name: "an undo whose target is another thing",
      child: () =>
        item(
          exact(
            "calendar_delete_event",
            "destructive",
            { id: "evt_1" },
            { target: recipient("evt_2") },
          ),
          {
            undo: { createdId: "evt_1" },
          },
        ),
      reason: "undo_unbound",
    },
    {
      name: "an undo with an extra selector on a reminder",
      child: () =>
        item(exact("reminders_delete", "destructive", { id: "rem_1", list: "all" }), {
          undo: { createdId: "rem_1" },
        }),
      reason: "undo_unbound",
    },
    {
      name: "an undo through a connector prefix (exact names only)",
      child: () =>
        item(exact("apple.calendar_delete_event", "destructive", { id: "evt_2" }), {
          undo: { createdId: "evt_2" },
        }),
      reason: ["undo_unbound", "destructive", "denied"],
    },
    {
      name: "a money word in a Google-shaped param of a plain write",
      child: () => item(exact("mail_set_flags", "write", { ids: ["m1"], note: "Pay $20 now" })),
      reason: "money_intent",
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
    ...(["reminders_create", "reminders_update", "reminders_complete"] as const).flatMap((tool) =>
      ["Pay rent", "Pay the plumber $120"].map((title) => ({
        name: `a ${tool} item titled "${title}"`,
        child: () =>
          item(exact(tool, "write", { title, notes: title }), { summary: `Reminder: ${title}` }),
      })),
    ),
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
      child: () =>
        item(send(["a@x.org", "b@x.org"]), {
          explicitSend: true,
          recipients: ["a@x.org", "b@x.org"],
        }),
    },
    {
      name: "an undo delete of an event Night shift created",
      child: () =>
        item(exact("calendar_delete_event", "destructive", { id: "evt_1" }), {
          undo: { createdId: "evt_1" },
        }),
    },
    {
      name: "an undo delete of a reminder Night shift created",
      child: () =>
        item(exact("reminders_delete", "destructive", { id: "rem_7" }), {
          undo: { createdId: "rem_7" },
        }),
    },
    {
      name: "mcp__apple__mail_send_draft with the id live",
      child: () =>
        item(
          exact(
            "mcp__apple__mail_send_draft",
            "destructive",
            { draftId: "d1", to: ["b@y.com", "a@x.com"], subject: "s", bodySha256: "h" },
            { kind: "send_email", target: recipient("a@x.com,b@y.com") },
          ),
          { explicitSend: true, recipients: ["a@x.com", "b@y.com"] },
        ),
    },
    {
      name: "mcp__google__gmail_send with the id live",
      child: () =>
        item(
          exact(
            "mcp__google__gmail_send",
            "destructive",
            { to: ["Dana <Dana@X.com>"], subject: "s", body: "b" },
            { kind: "send_email", target: recipient("dana@x.com") },
          ),
          { explicitSend: true, recipients: ["dana@x.com"] },
        ),
    },
    {
      name: "mcp__apple__calendar_delete_event undo with its real account target",
      child: () =>
        item(
          exact(
            "mcp__apple__calendar_delete_event",
            "destructive",
            { id: "evt_7", span: "this" },
            { target: { kind: "account", value: "apple" } },
          ),
          { undo: { createdId: "evt_7" } },
        ),
    },
    {
      name: "mcp__google__calendar_delete_event undo with the Google shape",
      child: () =>
        item(
          exact(
            "mcp__google__calendar_delete_event",
            "destructive",
            { calendarId: "primary", eventId: "evt_8", sendUpdates: "none" },
            { target: { kind: "account", value: "me@gmail.com" } },
          ),
          { undo: { createdId: "evt_8", calendarId: "primary" } },
        ),
    },
    {
      name: "mcp__apple__reminders_create titled Pay rent",
      child: () =>
        item(exact("mcp__apple__reminders_create", "write", { title: "Pay rent" }), {
          summary: "Pay rent",
        }),
    },
    {
      name: "an Apple undo delete with its real account target",
      child: () =>
        item(
          exact(
            "calendar_delete_event",
            "destructive",
            { id: "evt_5", span: "this" },
            { kind: "calendar_write", target: { kind: "account", value: "apple.calendar" } },
          ),
          { undo: { createdId: "evt_5" } },
        ),
    },
    {
      name: "an Apple reminder undo with its real account target",
      child: () =>
        item(
          exact(
            "reminders_delete",
            "destructive",
            { id: "rem_5" },
            { target: { kind: "account", value: "apple.reminders" } },
          ),
          { undo: { createdId: "rem_5" } },
        ),
    },
    {
      name: "a Google undo delete with its real account target",
      child: () =>
        item(
          exact(
            "calendar_delete_event",
            "destructive",
            { calendarId: "primary", eventId: "evt_6", sendUpdates: "none" },
            { kind: "calendar_write", target: { kind: "account", value: "me@gmail.com" } },
          ),
          { undo: { createdId: "evt_6", calendarId: "primary" } },
        ),
    },
    {
      name: "mail_send_draft to two people with the real sorted, comma-joined target",
      child: () =>
        item(
          exact(
            "mail_send_draft",
            "destructive",
            { draftId: "d1", to: ["b@y.com", "a@x.com"], subject: "s", bodySha256: "h" },
            { kind: "send_email", target: recipient("a@x.com,b@y.com") },
          ),
          { explicitSend: true, recipients: ["a@x.com", "b@y.com"] },
        ),
    },
    {
      name: "gmail_send to a display-name address with the bare target",
      child: () =>
        item(
          exact(
            "gmail_send",
            "destructive",
            { to: ["Dana <Dana@X.com>"], subject: "s", body: "b" },
            { kind: "send_email", target: recipient("dana@x.com") },
          ),
          { explicitSend: true, recipients: ["Dana <Dana@X.com>"] },
        ),
    },
    {
      name: "a send whose caller list is bare while the call has display names",
      child: () =>
        item(
          exact(
            "gmail_send",
            "destructive",
            { to: ["Dana <dana@x.com>"], cc: ["Lee <lee@x.com>"] },
            { kind: "send_email", target: recipient("dana@x.com,lee@x.com") },
          ),
          { explicitSend: true, recipients: ["dana@x.com", "lee@x.com"] },
        ),
    },
    {
      name: "an undo delete with the calendar the event was created in",
      child: () =>
        item(
          exact("calendar_delete_event", "destructive", {
            eventId: "evt_3",
            calendarId: "work",
            span: "this",
            sendUpdates: "none",
          }),
          { undo: { createdId: "evt_3", calendarId: "work" } },
        ),
    },
    {
      name: "a send whose recipients differ only in case and spacing",
      child: () =>
        item(send(["Dana@Example.com"]), {
          explicitSend: true,
          recipients: [" dana@example.com "],
        }),
    },
    {
      name: "a send with to, cc and bcc all listed",
      child: () =>
        item(send("a@x.org", { cc: ["b@x.org"], bcc: ["c@x.org"] }), {
          explicitSend: true,
          recipients: ["c@x.org", "b@x.org", "a@x.org"],
        }),
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
      item(send(["dana@example.com", "lee@example.com"]), {
        explicitSend: true,
        recipients: ["dana@example.com", "lee@example.com"],
      }),
    ]);
    const a = issued.approval;
    expect(a).toMatchObject({
      deviceOnly: true,
      sideEffect: "destructive",
      requiresAuthentication: false,
      riskClass: "sensitive",
    });
    expect(a.surfaces.some((s) => s.startsWith("oldchat"))).toBe(false);
    const items = (a.details as { items: { send?: { to: string[] } }[] }).items;
    expect(items[0]?.send).toBeUndefined();
    expect(items[1]?.send).toEqual({ to: ["dana@example.com", "lee@example.com"] });
  });

  it("the send row names the call's own recipients, lower-cased, not the caller's list", async () => {
    const h = makeBroker();
    const issued = await stage(h, [
      item(send(["Dana@Example.com"], { cc: ["LEE@example.com"] }), {
        explicitSend: true,
        recipients: ["lee@example.com", " DANA@example.com"],
      }),
    ]);
    const items = (issued.approval.details as { items: { send?: { to: string[] } }[] }).items;
    expect(items[0]?.send).toEqual({ to: ["dana@example.com", "lee@example.com"] });
  });

  it("the card shows bare addresses, cut from a display name and a joined target", async () => {
    const h = makeBroker();
    const issued = await stage(h, [
      item(
        exact(
          "gmail_send",
          "destructive",
          { to: ["Dana <Dana@X.com>"], cc: ["lee@x.com"] },
          { kind: "send_email", target: recipient("dana@x.com,lee@x.com") },
        ),
        { explicitSend: true, recipients: ["dana@x.com", "lee@x.com"] },
      ),
    ]);
    const items = (issued.approval.details as { items: { send?: { to: string[] } }[] }).items;
    expect(items[0]?.send).toEqual({ to: ["dana@x.com", "lee@x.com"] });
  });

  it("refuses a payment that only appears in the call a hook rewrote", async () => {
    const hook = {
      name: "rewrite",
      beforeToolCall: (c: PolicyCall) =>
        (c.params as { ids?: string[] }).ids?.[0] === "m_rewritten"
          ? { rewrite: { ...c, params: { ...(c.params as object), note: "Send $500 to Bob" } } }
          : undefined,
    };
    const h = makeBroker({ hooks: [hook] });
    const issued = await stage(h, [item(flags("m1")), item(flags("m_rewritten"))]);
    expect(issued.refused).toMatchObject([{ index: 1, reason: "money_intent" }]);
  });

  it("a set of writes only is still device-only, but a write (no destructive class)", async () => {
    const h = makeBroker();
    const issued = await stage(h, [item(flags("m1"))]);
    expect(issued.approval).toMatchObject({ deviceOnly: true, sideEffect: "write" });
    // No chat token exists, and a chat answer is refused: the review lives in the apps only.
    expect(Object.keys(issued.answerTokens).some((k) => k.startsWith("oldchat"))).toBe(false);
    h.clock.advance(500);
    await expect(
      h.broker.answer({
        approvalId: issued.approval.id,
        answerToken: issued.answerTokens.desktop ?? "",
        decision: "approve",
        scope: "once",
        decidedBy: OWNER,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // Positive control: a paired device answers it with a plain tap.
    expect((await answer(h, issued)).status).toBe("approved");
  });

  it("an undo delete makes the set device-only", async () => {
    const h = makeBroker();
    const a = (
      await stage(h, [
        item(exact("calendar_delete_event", "destructive", { id: "evt_1" }), {
          undo: { createdId: "evt_1" },
        }),
      ])
    ).approval;
    expect(a.deviceOnly).toBe(true);
    expect(a.surfaces.some((s) => s.startsWith("oldchat"))).toBe(false);
  });

  it("carries taint to the card and every child", async () => {
    const h = makeBroker();
    const issued = await h.broker.requestStagedApply({
      connectorIds: IDS,
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
      connectorIds: IDS,
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

describe("requestStagedApply: connector tool names", () => {
  it("unwraps only live connector ids, mirroring the registry's id sanitising", async () => {
    const { bareToolName } = await import("../src/staged-apply.ts");
    const live = new Set(["apple", "my.connector_1"]);
    expect(bareToolName("mcp__apple__reminders_create", live)).toBe("reminders_create");
    expect(bareToolName("mcp__my-connector-1__gmail_send", live)).toBe("gmail_send");
    expect(bareToolName("mcp__evil__gmail_send", live)).toBe("mcp__evil__gmail_send");
    expect(bareToolName("gmail_send", live)).toBe("gmail_send");
    expect(bareToolName("mcp__apple__x", new Set())).toBe("mcp__apple__x");
  });
});

describe("requestStagedApply: W5 review round 1", () => {
  it("an undo of a reminder with money words is allowed (owner rule), and still needs its undo binding", async () => {
    const del = () => exact("reminders_delete", "destructive", { id: "rem_1" });
    const undo = await verdict(
      item(del(), { summary: "Undo: Pay rent $1,200", undo: { createdId: "rem_1" } }),
    );
    expect(undo.refused).toEqual([]);
    // Control: the same delete that is not an undo of what Night shift created is refused.
    const bare = await verdict(item(del(), { summary: "Undo: Pay rent $1,200" }));
    expect(bare.refused.map((r) => r.reason)).not.toContain("money_intent");
    expect(bare.refused).toHaveLength(1);
  });

  it("a withheld item shows its generic line, the withheld flag and no send recipients", async () => {
    const h = makeBroker();
    const plain = item(flags("keep"));
    const hidden = item(flags("m1"), { summary: "An item from Messages", withheld: "messages" });
    const hiddenSend = item(send("dana@example.com"), {
      summary: "An item from Messages",
      explicitSend: true,
      recipients: ["dana@example.com"],
      withheld: "messages",
    });
    const shown = item(send("erin@example.com"), {
      summary: "Send to erin@example.com",
      explicitSend: true,
      recipients: ["erin@example.com"],
    });
    const issued = await stage(h, [plain, hidden, hiddenSend, shown]);
    expect(issued.refused).toEqual([]);
    const items = (issued.approval.details as { items: Record<string, unknown>[] }).items;
    expect(items[0]?.withheld).toBeUndefined();
    expect(items[1]).toMatchObject({ withheld: "messages", summary: "An item from Messages" });
    expect(items[2]).toMatchObject({ withheld: "messages", send: {} });
    expect(JSON.stringify(issued.approval)).not.toContain("dana@example.com");
    // Control: a send that is not withheld names its recipients.
    expect(items[3]).toMatchObject({ send: { to: ["erin@example.com"] } });
  });
});
