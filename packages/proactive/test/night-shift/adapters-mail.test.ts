import { describe, expect, it } from "vitest";
import {
  checkSendRecipe,
  draftContentHash,
  mailAdapter,
} from "../../src/night-shift/adapters/mail.ts";
import type { CaptureOk, MailDraftInfo, StagedCall } from "../../src/night-shift/adapters/types.ts";
import { FakeRegistry, thread } from "./adapters-registry.ts";

function setup() {
  const reg = new FakeRegistry();
  reg.threads.set("t-1", thread());
  return { reg, adapter: mailAdapter(reg) };
}

const reply = (extra: Record<string, unknown> = {}): StagedCall => ({
  tool: "gmail_create_draft",
  args: {
    threadId: "t-1",
    to: ["ann@x.com"],
    subject: "Re: plan",
    body: "Sounds good",
    ...extra,
  },
});

describe("mail adapter capture", () => {
  it("captures a draft whose recipients are the thread's participants", async () => {
    const { adapter } = setup();
    const r = await adapter.capture(reply({ cc: ["Bob <BOB@x.com>"] }));
    expect(r).toMatchObject({ ok: true, target: "t-1" });
  });

  it("captures an Apple reply by message id with no explicit recipients", async () => {
    const { reg, adapter } = setup();
    reg.threads.set("t-m-5", thread({ threadId: "t-m-5" }));
    const r = await adapter.capture({ tool: "mail_reply_draft", args: { id: "m-5", body: "ok" } });
    expect(r).toMatchObject({ ok: true, target: "t-m-5" });
  });

  const REFUSED: Array<[string, StagedCall, string]> = [
    ["added to", reply({ to: ["ann@x.com", "eve@evil.com"] }), "recipient_added"],
    ["added cc", reply({ cc: ["eve@evil.com"] }), "recipient_added"],
    ["added bcc", reply({ bcc: ["eve@evil.com"] }), "recipient_added"],
    ["lookalike domain", reply({ to: ["ann@x.com.evil.com"] }), "recipient_added"],
    ["display name spoof", reply({ to: ["ann@x.com <eve@evil.com>"] }), "recipient_added"],
    ["forward by subject", reply({ subject: "Fwd: plan" }), "forward_refused"],
    ["forward by flag", reply({ forward: true }), "forward_refused"],
    [
      "forward tool",
      { tool: "mail_forward_draft", args: { id: "m-1", to: ["ann@x.com"] } },
      "forward_refused",
    ],
    ["attachment", reply({ attachments: ["/Users/o/secret.pdf"] }), "attachments_refused"],
    [
      "no thread",
      { tool: "mail_draft", args: { to: ["ann@x.com"], subject: "s", body: "b" } },
      "no_thread",
    ],
    ["unknown thread", reply({ threadId: "t-404" }), "thread_gone"],
    ["non-array to", reply({ to: "ann@x.com" }), "bad_recipients"],
  ];
  it.each(REFUSED)("refuses %s", async (_n, call, reason) => {
    const { adapter } = setup();
    expect(await adapter.capture(call)).toEqual({ ok: false, reason });
  });

  it("refuses when the registry cannot answer", async () => {
    const { reg, adapter } = setup();
    reg.failing = true;
    expect(await adapter.capture(reply())).toEqual({ ok: false, reason: "thread_unreadable" });
  });
});

describe("mail adapter check", () => {
  async function captured() {
    const s = setup();
    const call = reply();
    const cap = (await s.adapter.capture(call)) as CaptureOk;
    return { ...s, call, cap };
  }

  it("is fresh when nothing changed", async () => {
    const { adapter, call, cap } = await captured();
    expect(await adapter.check(call, cap)).toEqual({ fresh: true });
  });

  it("is stale when a new message arrived", async () => {
    const { reg, adapter, call, cap } = await captured();
    reg.threads.set("t-1", thread({ newestMessageId: "m-10", count: 4 }));
    expect(await adapter.check(call, cap)).toEqual({ fresh: false, reason: "new_message" });
  });

  it("is stale when the thread is gone", async () => {
    const { reg, adapter, call, cap } = await captured();
    reg.threads.delete("t-1");
    expect(await adapter.check(call, cap)).toEqual({ fresh: false, reason: "thread_gone" });
  });

  it("is stale when a participant left the thread (recipient no longer on it)", async () => {
    const { reg, adapter, call, cap } = await captured();
    reg.threads.set("t-1", thread({ participants: ["owner@x.com", "bob@x.com"] }));
    expect(await adapter.check(call, cap)).toEqual({ fresh: false, reason: "recipient_added" });
  });

  it("is stale, not fresh, when the registry fails", async () => {
    const { reg, adapter, call, cap } = await captured();
    reg.failing = true;
    expect(await adapter.check(call, cap)).toEqual({ fresh: false, reason: "thread_unreadable" });
  });

  it("has no inverse", async () => {
    const { adapter } = await captured();
    expect(adapter.inverse).toBeUndefined();
  });

  it("previews as plain data, with markup and line breaks neutralised", async () => {
    const { adapter } = setup();
    const call = reply({ body: "<script>alert(1)</script>\u0085\u2028line two\u202e" });
    const cap = (await adapter.capture(call)) as CaptureOk;
    const p = adapter.preview(call, cap);
    const body = p.rows.find((r) => r.label === "Body")?.value ?? "";
    expect(body).toContain("<script>alert(1)</script>"); // data, not rendered, not escaped
    expect(body).not.toMatch(/[\u0085\u2028\u202e\n]/u);
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
    for (const r of p.rows) expect(typeof r.value).toBe("string");
  });
});

describe("send recipe", () => {
  const draft: MailDraftInfo = {
    to: ["ann@x.com"],
    cc: ["bob@x.com"],
    bcc: [],
    subject: "Re: plan",
    body: "ok",
    inReplyTo: "<m-9@x>",
    attachments: [],
  };
  const hash = draftContentHash(draft);

  it("hash covers to, cc, bcc, subject, body, in-reply-to and attachments", () => {
    const variants: Array<Partial<MailDraftInfo>> = [
      { to: ["bob@x.com"] },
      { cc: [] },
      { bcc: ["ann@x.com"] },
      { subject: "Re: plan!" },
      { body: "ok." },
      { inReplyTo: "<other@x>" },
      { attachments: ["a.pdf"] },
    ];
    for (const v of variants) expect(draftContentHash({ ...draft, ...v })).not.toBe(hash);
    // Order and display form of recipients do not change it.
    expect(draftContentHash({ ...draft, to: ["Ann <ANN@x.com>"] })).toBe(hash);
  });

  function reg(d: MailDraftInfo | null) {
    const r = new FakeRegistry();
    r.threads.set("t-1", thread());
    if (d) r.drafts.set("d-1", d);
    return r;
  }
  const input = { draftId: "d-1", expectedHash: hash, threadId: "t-1" };

  it("sends an unchanged draft and lists the recipients", async () => {
    expect(await checkSendRecipe(reg(draft), input)).toEqual({
      ok: true,
      recipients: ["ann@x.com", "bob@x.com"],
    });
  });

  const CHANGED: Array<[string, Partial<MailDraftInfo>]> = [
    ["body", { body: "edited" }],
    ["subject", { subject: "x" }],
    ["bcc", { bcc: ["bob@x.com"] }],
    ["attachment", { attachments: ["a.pdf"] }],
  ];
  it.each(CHANGED)("refuses a draft whose %s changed", async (_n, v) => {
    expect(await checkSendRecipe(reg({ ...draft, ...v }), input)).toEqual({
      ok: false,
      reason: "draft_changed",
    });
  });

  it("refuses a missing draft, a gone thread and an unreadable registry", async () => {
    expect(await checkSendRecipe(reg(null), input)).toEqual({ ok: false, reason: "draft_gone" });
    const noThread = reg(draft);
    noThread.threads.clear();
    expect(await checkSendRecipe(noThread, input)).toEqual({ ok: false, reason: "thread_gone" });
    const down = reg(draft);
    down.failing = true;
    expect(await checkSendRecipe(down, input)).toEqual({ ok: false, reason: "draft_unreadable" });
  });

  it("refuses a recipient added even when the hash was re-recorded", async () => {
    const edited = { ...draft, to: ["ann@x.com", "eve@evil.com"] };
    expect(
      await checkSendRecipe(reg(edited), { ...input, expectedHash: draftContentHash(edited) }),
    ).toEqual({ ok: false, reason: "recipient_added" });
  });
});
