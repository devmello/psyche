import { bindStagedApproval, pruneClosedNights, updateNight, updateStagedAction } from "@psyche/db";
import { PsycheError } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  appleBodySha256,
  checkSavedDraft,
  createNightShiftHandlers,
  draftIdOf,
  MESSAGES_ITEM_LINE,
  validateNightShiftSetting,
} from "../../src/index.ts";
import { applyRig, FROM_MESSAGES, RECIPIENTS } from "./apply-rig.ts";

/**
 * Night shift W5 (docs/design/night-shift-2026.md §2.4, §3.2, §3.3, §5.3, §5.4) through the real
 * broker and a real SQLite store. Every refusal row has a control: the clean apply below.
 */

const HOUR = 3_600_000;

describe("apply: control", () => {
  it("applies the ticked items once, sends the ticked send after the draft reads back, settles applied", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    const b = r.reminder("Renew passport");
    const d = r.draft();
    const out = await r.applier.apply({
      reviewId: r.night.id,
      items: [r.tick(a), r.tick(b), r.tick(d)],
      sends: [{ itemId: d.id, sendHash: d.send?.contentHash ?? "" }],
    });
    expect(out.refused).toEqual([]);
    expect(out.issued?.approval).toMatchObject({ kind: "staged_apply", deviceOnly: true });
    // Taint is the union of the items' taint.
    expect(out.issued?.approval.taint).toBe(true);
    // Bound while the card is open.
    expect(r.item(a.id).approvalId).toBe(out.issued?.approval.id);
    if (out.issued === undefined) throw new Error("no approval");
    await r.approve(out.issued);
    expect(r.ran.map((x) => [x.tool, x.callId])).toEqual([
      ["reminders_create", a.id],
      ["reminders_create", b.id],
      ["mail_draft", d.id],
      ["mail_send_draft", `${d.id}:send`],
    ]);
    const send = r.ran.at(-1)?.params as Record<string, unknown>;
    expect(send).toMatchObject({ draftId: "draft_3", to: ["ann@x.com", "bob@x.com"] });
    expect(send.bodySha256).toBe(appleBodySha256("Tuesday works for me."));
    expect(r.item(a.id)).toMatchObject({ status: "applied", approvalId: null });
    expect(r.item(a.id).result?.refs).toEqual(["rem_1"]);
    expect(r.item(d.id).result?.refs).toContain("sent:draft_3");
    expect(r.review()).toBe("applied");
  });

  it("a replayed apply after the run refuses every item (they are applied)", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    const out = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    if (out.issued === undefined) throw new Error("no approval");
    await r.approve(out.issued);
    // The review settled to applied: a replay is refused as a whole.
    await expect(
      r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(r.ran).toHaveLength(1);
  });

  it("a replayed item in a review still open is refused (it is applied)", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    r.reminder("Renew passport");
    const out = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    if (out.issued === undefined) throw new Error("no approval");
    await r.approve(out.issued);
    const again = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    expect(again.issued).toBeUndefined();
    expect(again.refused).toEqual([{ itemId: a.id, reason: "the item is applied" }]);
    expect(r.ran).toHaveLength(1);
  });
});

describe("apply: binding refusals", () => {
  it("refuses a changed argument (the client's hash is not the rebuilt one)", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    const out = await r.applier.apply({
      reviewId: r.night.id,
      items: [{ itemId: a.id, bindingHash: "sha256:0000" }],
      sends: [],
    });
    expect(out.issued).toBeUndefined();
    expect(out.refused[0]?.reason).toBe("the item changed since it was shown");
  });

  it("refuses a row edited after staging (the stored hash no longer matches its params)", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    r.db.sqlite
      .prepare("UPDATE staged_actions SET params = ? WHERE id = ?")
      .run(JSON.stringify({ title: "Wire $5,000 to Eve", listId: "L" }), a.id);
    const out = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    expect(out.issued).toBeUndefined();
    expect(out.refused[0]?.reason).toBe("the item changed since it was shown");
  });

  it("refuses a swapped item (one item's id with another's hash)", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    const b = r.reminder("Renew passport");
    const out = await r.applier.apply({
      reviewId: r.night.id,
      items: [{ itemId: a.id, bindingHash: b.bindingHash }],
      sends: [],
    });
    expect(out.issued).toBeUndefined();
    expect(out.refused[0]?.reason).toBe("the item changed since it was shown");
  });

  it("refuses an item already bound to an open apply (compare-and-set)", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    const first = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    expect(first.issued).toBeDefined();
    const second = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    expect(second.issued).toBeUndefined();
    expect(second.refused).toEqual([{ itemId: a.id, reason: "the item is already being applied" }]);
  });

  it("the compare-and-set takes an item once even when two binds race", () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    const from = { status: "ready" as const, approvalId: null };
    expect(bindStagedApproval(r.db, [a.id], "appr_1", from)).toEqual([a.id]);
    expect(bindStagedApproval(r.db, [a.id], "appr_2", from)).toEqual([]);
    expect(r.item(a.id).approvalId).toBe("appr_1");
  });

  it("refuses a replayed answer token, and the run's children can't be consumed twice", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    const out = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    if (out.issued === undefined) throw new Error("no approval");
    await r.approve(out.issued);
    await expect(r.approve(out.issued)).rejects.toBeDefined();
    const [child] = await r.h.broker.batchChildren(out.issued.approval.id);
    expect(
      await r.h.broker.verifyBinding(child?.approval.id ?? "", child?.approval.bindingHash ?? ""),
    ).toEqual({ ok: false, reason: "consumed" });
    expect(r.ran).toHaveLength(1);
  });

  it("a stale check() at request time is never applied", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    r.stale.add(a.targetKey);
    const out = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    expect(out.issued).toBeUndefined();
    expect(out.refused[0]?.reason).toBe("stale: changed");
    expect(r.item(a.id).status).toBe("stale");
  });

  it("check() runs again right before each item: one going stale after the tap is skipped", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    const b = r.reminder("Renew passport");
    const out = await r.applier.apply({
      reviewId: r.night.id,
      items: [r.tick(a), r.tick(b)],
      sends: [],
    });
    if (out.issued === undefined) throw new Error("no approval");
    r.stale.add(b.targetKey);
    await r.approve(out.issued);
    expect(r.ran.map((x) => x.callId)).toEqual([a.id]);
    expect(r.item(b.id)).toMatchObject({ status: "stale", approvalId: null });
    expect(r.item(a.id).status).toBe("applied");
    expect(r.review()).toBe("partial");
  });

  it("a denied card unbinds the items and runs nothing", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    const out = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    if (out.issued === undefined) throw new Error("no approval");
    r.clock.advance(500);
    await r.h.broker.answer({
      approvalId: out.issued.approval.id,
      answerToken: out.issued.answerTokens.desktop ?? "",
      decision: "deny",
      decidedBy: { deviceId: "dev_mac" },
    } as never);
    await r.settle();
    expect(r.ran).toEqual([]);
    expect(r.item(a.id)).toMatchObject({ status: "ready", approvalId: null });
  });

  it("a mid-flight throw is uncertain, never retried, and the review is partial", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    const b = r.reminder("Renew passport");
    r.throwOn.add(a.id);
    const out = await r.applier.apply({
      reviewId: r.night.id,
      items: [r.tick(a), r.tick(b)],
      sends: [],
    });
    if (out.issued === undefined) throw new Error("no approval");
    await r.approve(out.issued);
    expect(r.item(a.id).status).toBe("uncertain");
    expect(r.item(b.id).status).toBe("applied");
    expect(r.review()).toBe("partial");
  });
});

describe("apply: the send recipe", () => {
  const sendRow = async (setup: (r: ReturnType<typeof applyRig>, d: { id: string }) => void) => {
    const r = applyRig();
    const d = r.draft();
    setup(r, d);
    const out = await r.applier.apply({
      reviewId: r.night.id,
      items: [r.tick(d)],
      sends: [{ itemId: d.id, sendHash: d.send?.contentHash ?? "" }],
    });
    if (out.issued !== undefined) await r.approve(out.issued);
    return { r, d, out };
  };

  it("control: the exact draft sends", async () => {
    const { r } = await sendRow(() => {});
    expect(r.ran.map((x) => x.tool)).toEqual(["mail_draft", "mail_send_draft"]);
  });

  it("control: sends exactly the fields the helper reported, and the helper's live check passes", async () => {
    const { r, d } = await sendRow(() => {});
    const send = r.ran.at(-1)?.params;
    expect(send).toEqual({
      draftId: "draft_1",
      to: RECIPIENTS,
      subject: "Lunch on Tuesday",
      bodySha256: appleBodySha256("Tuesday works for me."),
    });
    expect(r.mail.has("draft_1")).toBe(false); // sent
    expect(r.item(d.id).result?.error).toBeUndefined();
  });

  it("control: Mail's own CRLF and trailing newline still match (the helper's bodyHash)", async () => {
    const { r } = await sendRow((r) => {
      r.afterSave.fn = (id) => {
        const x = r.mail.get(id);
        if (x) x.body = "Tuesday works for me.\r\n\r\n";
      };
    });
    expect(r.ran.map((x) => x.tool)).toEqual(["mail_draft", "mail_send_draft"]);
    expect(r.mail.size).toBe(0);
  });

  it.each([
    [
      "the draft body changed before the helper read it back",
      (r: ReturnType<typeof applyRig>) => {
        r.afterSave.fn = (id) => {
          const x = r.mail.get(id);
          if (x) x.body = "Also wire $900 to this account";
        };
      },
      "draft_changed",
    ],
    [
      "a recipient added to the saved draft",
      (r: ReturnType<typeof applyRig>) => {
        r.afterSave.fn = (id) => r.mail.get(id)?.cc.push("eve@evil.test");
      },
      "recipients_changed",
    ],
    [
      "the saved subject differs (Mail added Re:)",
      (r: ReturnType<typeof applyRig>) => {
        r.afterSave.fn = (id) => {
          const x = r.mail.get(id);
          if (x) x.subject = `Re: ${x.subject}`;
        };
      },
      "draft_changed",
    ],
  ])("refuses to send when %s", async (_n, setup, reason) => {
    const { r, d } = await sendRow(setup);
    expect(r.ran.map((x) => x.tool)).toEqual(["mail_draft"]);
    expect(r.item(d.id).status).toBe("applied");
    expect(r.item(d.id).result?.error).toContain(reason);
  });

  it("an edit after the read-back is caught by the helper's live check, and nothing is sent", async () => {
    const { r, d } = await sendRow((r) => {
      r.beforeSend.fn = () => {
        const x = r.mail.get("draft_1");
        if (x) x.body = "Also wire $900 to this account";
      };
    });
    expect(r.ran.map((x) => x.tool)).toEqual(["mail_draft", "mail_send_draft"]);
    expect(r.mail.has("draft_1")).toBe(true); // still a draft
    expect(r.item(d.id).status).toBe("applied");
    // The helper refused before acting (binding_mismatch): before the effect, not uncertain.
    expect(r.item(d.id).result?.error).toMatch(/^send before_effect: .*draft changed/);
  });

  it.each([
    ["gmail_create_draft", "Gmail drafts can't be read back"],
    ["mail_reply_draft", "a reply's saved draft can't be checked"],
  ] as const)(
    "refuses the send of a %s at request time with a clear reason, and keeps the draft",
    async (tool, reason) => {
      const r = applyRig();
      const d = r.draft(undefined, undefined, tool);
      expect(d.send).not.toBeNull();
      const out = await r.applier.apply({
        reviewId: r.night.id,
        items: [r.tick(d)],
        sends: [{ itemId: d.id, sendHash: d.send?.contentHash ?? "" }],
      });
      expect(out.refused).toHaveLength(1);
      expect(out.refused[0]?.reason).toContain(reason);
      if (out.issued === undefined) throw new Error("no approval");
      await r.approve(out.issued);
      expect(r.ran.map((x) => x.tool)).toEqual([tool]);
      expect(r.item(d.id).status).toBe("applied");
    },
  );

  it("checkSavedDraft: staged bcc is refused, display names and order are fine, hidden text refused", () => {
    const saved = {
      draftId: "d",
      subject: "Hi",
      to: ["Bob <BOB@x.com>", "ann@x.com"],
      cc: [],
      body: "Yes",
      bodySha256: appleBodySha256("Yes"),
    };
    const staged = { to: RECIPIENTS, subject: "Hi", body: "Yes" };
    expect(checkSavedDraft(saved, staged, RECIPIENTS)).toEqual({ ok: true });
    expect(checkSavedDraft(saved, { ...staged, bcc: ["bob@x.com"] }, RECIPIENTS)).toEqual({
      ok: false,
      reason: "bcc_unverifiable",
    });
    expect(
      checkSavedDraft({ ...saved, subject: "Hi‮" }, { ...staged, subject: "Hi‮" }, RECIPIENTS),
    ).toEqual({ ok: false, reason: "hidden_content" });
    expect(checkSavedDraft({ ...saved, bodySha256: "00" }, staged, RECIPIENTS)).toEqual({
      ok: false,
      reason: "draft_changed",
    });
  });

  it("refuses a send whose hash is not the stored content hash, and keeps the draft", async () => {
    const r = applyRig();
    const d = r.draft();
    const out = await r.applier.apply({
      reviewId: r.night.id,
      items: [r.tick(d)],
      sends: [{ itemId: d.id, sendHash: "sha256:other" }],
    });
    expect(out.refused).toEqual([{ itemId: d.id, reason: "the send doesn't match the draft" }]);
    if (out.issued === undefined) throw new Error("no approval");
    await r.approve(out.issued);
    expect(r.ran.map((x) => x.tool)).toEqual(["mail_draft"]);
  });

  it("refuses a send whose stored recipients were edited after staging", async () => {
    const r = applyRig();
    const d = r.draft();
    r.db.sqlite.prepare("UPDATE staged_actions SET send = ? WHERE id = ?").run(
      JSON.stringify({
        recipients: ["ann@x.com", "eve@evil.test"],
        contentHash: d.send?.contentHash,
      }),
      d.id,
    );
    const out = await r.applier.apply({
      reviewId: r.night.id,
      items: [r.tick(d)],
      sends: [{ itemId: d.id, sendHash: d.send?.contentHash ?? "" }],
    });
    expect(out.refused).toEqual([{ itemId: d.id, reason: "the send doesn't match the draft" }]);
  });

  it("refuses a send without its draft ticked", async () => {
    const r = applyRig();
    const d = r.draft();
    const out = await r.applier.apply({
      reviewId: r.night.id,
      items: [],
      sends: [{ itemId: d.id, sendHash: d.send?.contentHash ?? "" }],
    });
    expect(out.issued).toBeUndefined();
    expect(out.refused).toEqual([{ itemId: d.id, reason: "a send needs its draft ticked too" }]);
  });

  // Each hash is what Swift's `MailWave1.bodyHash` printed for the input (a probe on this Mac).
  it.each([
    [
      "CRLF and CR",
      "a\r\nb\rc",
      "ea7fb08b7a2dc4619ffb7c7bb38d95a2047935fa165d71b12efd3852a2e6d0cc",
    ],
    [
      "a doubled CRLF",
      "a\r\n\r\nb",
      "38022fd2b8dbc5cb3d2cee74e083edbf59e3d4e13d067ebcb5db633d4cff4d8c",
    ],
    [
      "NEL, U+2028 and tab trimmed",
      "  \u0085hi \t",
      "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
    ],
    [
      "U+200B trimmed at both ends",
      "​hi​",
      "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
    ],
    ["U+FEFF kept", "﻿hi", "7611e336d2b333aa772acee003373474c86cd9ce975c10d66a4b0156e8641dca"],
    [
      "ideographic space and NBSP trimmed",
      "　x ",
      "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
    ],
    ["a trailing CR", "x\r", "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"],
    [
      "CRLF before a combining mark",
      "a\r\ńb",
      "b1f810bbe6689c03b82f2c7d7c9eec158a72aab1748929342213051dda814a15",
    ],
    [
      "CR before a combining mark",
      "a\ŕb",
      "d1c187158dd30af267e87aa37cc90ee945303c76d6bbd5973209477ebd71e37d",
    ],
    [
      "CR before ZWJ (not blocked)",
      "a\r‍b",
      "4aad8a67d33307d923c5e307ed7ebcb473c44549bff3b18f278bb9853bd4b8ef",
    ],
    [
      "CRLF before ZWJ (not blocked)",
      "a\r\n‍b",
      "4aad8a67d33307d923c5e307ed7ebcb473c44549bff3b18f278bb9853bd4b8ef",
    ],
    [
      "CR before an emoji modifier",
      "a\r\u{1F3FB}b",
      "f10552ec9b3a95be6559a7c6746ce065f0cde6bbcafbcae38850211069ee42c6",
    ],
    ["CR before VS16", "a\r️b", "1c043b6a3160e0f43a7f19686e38644e62ae106998568a8f37dd976f39c6fd73"],
    ["CR before ZWNJ", "a\r‌b", "aab67658bbc4a00aa5d73d68d9c5dcf3988d3cf49ed6dd67c899d15484fccf58"],
    [
      "CR before a spacing mark (not blocked)",
      "a\rःb",
      "ce229666d7e86f39a318ed1496284e0ce8f71be15260961f9d38d374f9874104",
    ],
    [
      "a leading space before a combining mark",
      " ́x",
      "2f9e1ecca62f443d014d82c29b10c86d34a1ecfa79e9285bc0a3e0fb29b731da",
    ],
    [
      "a trailing space before a combining mark",
      "x ́",
      "81bb1e82044c0aa11a9e3da800bb20f282926482981b7da0ecc6e3e5493cd424",
    ],
  ])("matches Swift's bodyHash: %s", (_n, input, swift) => {
    expect(appleBodySha256(input)).toBe(swift);
  });

  it("parses the draft id from either connector's answer", () => {
    expect(draftIdOf({ draft: { draftId: "42", bodySha256: "x" } })).toBe("42");
    expect(draftIdOf({ draftId: "g1", messageId: "m" })).toBe("g1");
    expect(draftIdOf({ draft: {} })).toBeUndefined();
  });
});

describe("recover after a restart", () => {
  it("an item bound to a dead or invalidated approval goes back to ready", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    bindStagedApproval(r.db, [a.id], "appr_gone", { status: "ready", approvalId: null });
    await r.applier.recover();
    expect(r.item(a.id)).toMatchObject({ status: "ready", approvalId: null });
  });

  it("an item bound to a pending card stays bound (control)", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    const out = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    await r.applier.recover();
    expect(r.item(a.id).approvalId).toBe(out.issued?.approval.id);
  });

  it("an item bound to an approved apply that never ran becomes uncertain", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    const out = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    if (out.issued === undefined) throw new Error("no approval");
    r.applier.stop(); // the Gateway went down before the run
    await r.approve(out.issued);
    expect(r.ran).toEqual([]);
    await r.newApplier().recover();
    expect(r.item(a.id)).toMatchObject({ status: "uncertain", approvalId: null });
  });
});

describe("undo", () => {
  async function applied() {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    const out = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    if (out.issued === undefined) throw new Error("no approval");
    await r.approve(out.issued);
    return { r, a };
  }

  it("control: deletes exactly what the apply created, through a staged_apply card", async () => {
    const { r, a } = await applied();
    const out = await r.applier.undo([a.id]);
    expect(out.refused).toEqual([]);
    if (out.issued === undefined) throw new Error("no approval");
    expect(out.issued.approval.kind).toBe("staged_apply");
    await r.approve(out.issued);
    expect(r.ran.at(-1)).toMatchObject({
      tool: "reminders_delete",
      callId: a.id,
      params: { id: "rem_1" },
    });
    expect(r.item(a.id).status).toBe("undone");
  });

  it("refuses a createdId that is not in the apply's result refs", async () => {
    const { r, a } = await applied();
    updateStagedAction(r.db, a.id, { result: { refs: ["rem_999"] } });
    const out = await r.applier.undo([a.id]);
    expect(out.issued).toBeUndefined();
    expect(out.refused[0]?.itemId).toBe(a.id);
    expect(r.ran.map((x) => x.tool)).toEqual(["reminders_create"]);
  });

  it("refuses an item applied more than 24 hours ago", async () => {
    const { r, a } = await applied();
    r.clock.advance(24 * HOUR + 1);
    const out = await r.applier.undo([a.id]);
    expect(out.refused).toEqual([{ itemId: a.id, reason: "the undo window has passed" }]);
  });

  it("refuses an item whose target changed since apply (checkInverse)", async () => {
    const { r, a } = await applied();
    r.inverseStale.add(a.targetKey);
    const out = await r.applier.undo([a.id]);
    expect(out.issued).toBeUndefined();
    expect(out.refused[0]?.reason).toContain("changed since it was applied");
  });

  it("refuses an item that was never applied", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    expect((await r.applier.undo([a.id])).refused).toEqual([
      { itemId: a.id, reason: "the item is ready" },
    ]);
  });
});

describe("dismiss", () => {
  it("dismisses ready items, never a bound one, and settles the review", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    const b = r.reminder("Renew passport");
    await r.applier.apply({ reviewId: r.night.id, items: [r.tick(b)], sends: [] });
    expect(r.applier.dismiss(r.night.id)).toBe(1);
    expect(r.item(a.id)).toMatchObject({ status: "dismissed", params: null });
    expect(r.item(b.id).status).toBe("ready");
  });
});

describe("nightShift.* settings schema", () => {
  const reject: [string, unknown][] = [
    ["nightShift.enabled", "yes"],
    ["nightShift.notify", 1],
    ["nightShift.domains.mail", "true"],
    ["nightShift.domains.calendar", 0],
    ["nightShift.domains.reminders", {}],
    ["nightShift.domains.files", "on"],
    ["nightShift.consentedAt", "not a date"],
    ["nightShift.window.start", "25:00"],
    ["nightShift.window.end", "5:00"],
    ["nightShift.budgetUsd", 5.01],
    ["nightShift.budgetUsd", 0.01],
    ["nightShift.expiryDays", 8],
    ["nightShift.expiryDays", 2.5],
    ["nightShift.somethingElse", true],
  ];
  it.each(reject)("refuses %s = %j", (key, value) => {
    expect(() => validateNightShiftSetting(key, value)).toThrow(/nightShift/);
  });
  const accept: [string, unknown][] = [
    ["nightShift.enabled", true],
    ["nightShift.consentedAt", "2026-11-24T10:00:00.000Z"],
    ["nightShift.window.start", "01:00"],
    ["nightShift.window.end", "05:30"],
    ["nightShift.budgetUsd", 0.5],
    ["nightShift.expiryDays", 7],
    ["nightShift.domains.files", false],
    ["nightShift.enabled", null],
    ["daily.enabled", "anything"],
  ];
  it.each(accept)("accepts %s = %j", (key, value) => {
    expect(validateNightShiftSetting(key, value)).toEqual(value);
  });
});

describe("prune (§7)", () => {
  it("deletes closed reviews 30 days after they close, with their items; keeps the rest", () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    updateNight(r.db, r.night.id, { reviewStatus: "applied" });
    const cut = (days: number) => new Date(r.clock.now() - days * 86_400_000).toISOString();
    expect(pruneClosedNights(r.db, cut(30))).toEqual({ nights: 0, items: 0 });
    r.clock.advance(31 * 86_400_000);
    expect(pruneClosedNights(r.db, cut(30))).toEqual({ nights: 1, items: 1 });
    expect(r.item(a.id)).toBeNull();
  });

  it("never deletes a review still waiting for the owner", () => {
    const r = applyRig();
    r.reminder("Call the dentist");
    r.clock.advance(60 * 86_400_000);
    expect(pruneClosedNights(r.db, new Date(r.clock.now()).toISOString())).toEqual({
      nights: 0,
      items: 0,
    });
  });
});

/** A staged_apply card's `details.items`. */
const detailItems = (a: { details?: unknown } | undefined): Record<string, unknown>[] =>
  ((a?.details ?? {}) as { items?: Record<string, unknown>[] }).items ?? [];

describe("items from Messages (owner rule: no Messages text off this Mac)", () => {
  const SECRET = "Pick up Mia from the dentist at 4";
  const LOCAL = { local: true };

  /** Everything a remote device can read about the card: broker events, approvals.list, the answers. */
  function leakRig() {
    const r = applyRig();
    const events: unknown[] = [];
    r.h.broker.subscribe((e) => events.push(e));
    const handlers = createNightShiftHandlers(r.applier);
    const seen = async () => JSON.stringify([events, await r.h.broker.list()]);
    return { r, events, handlers, seen };
  }

  it("a remote caller can't apply or undo an item from Messages, even with its binding hash", async () => {
    const { r, handlers } = leakRig();
    const m = r.reminder(SECRET, FROM_MESSAGES);
    const out = await handlers["nightShift.apply"](
      { reviewId: r.night.id, items: [r.tick(m)], sends: [] },
      { surface: "device:dev_phone", local: false },
    );
    expect(out.approval).toBeUndefined();
    expect(out.refused).toEqual([
      {
        itemId: m.id,
        reason: "items from your Messages can be applied only in Psyche on this Mac",
      },
    ]);
    expect(r.item(m.id).approvalId).toBeNull();
    // Applied from the Mac, then undo asked from the phone.
    const ok = await r.applier.apply(
      { reviewId: r.night.id, items: [r.tick(m)], sends: [] },
      LOCAL,
    );
    if (ok.issued === undefined) throw new Error("no approval");
    await r.approve(ok.issued);
    const undo = await handlers["nightShift.undo"](
      { itemIds: [m.id] },
      { surface: "device:dev_phone", local: false },
    );
    expect(undo.approval).toBeUndefined();
    expect(undo.refused[0]?.reason).toContain("only in Psyche on this Mac");
  });

  it("the Mac's apply and undo of an item from Messages never carry its text: events, approvals.list, the answers", async () => {
    const { r, handlers, seen } = leakRig();
    const m = r.reminder(SECRET, FROM_MESSAGES);
    const applied = await handlers["nightShift.apply"](
      { reviewId: r.night.id, items: [r.tick(m)], sends: [] },
      { surface: "desktop", local: true },
    );
    const items = detailItems(applied.approval);
    expect(items[0]).toMatchObject({
      itemId: m.id,
      summary: MESSAGES_ITEM_LINE,
      withheld: "messages",
    });
    expect(JSON.stringify(applied)).not.toContain(SECRET);
    const issued = await r.h.broker.get(applied.approval?.id ?? "");
    if (issued === undefined) throw new Error("no approval");
    await r.approve({ approval: issued, answerTokens: { desktop: applied.answerToken ?? "" } });
    expect(r.item(m.id).status).toBe("applied");
    const undone = await handlers["nightShift.undo"](
      { itemIds: [m.id] },
      { surface: "desktop", local: true },
    );
    const undoItems = detailItems(undone.approval);
    expect(undoItems[0]).toMatchObject({
      summary: `Undo: ${MESSAGES_ITEM_LINE}`,
      withheld: "messages",
    });
    expect(JSON.stringify(undone)).not.toContain(SECRET);
    const all = await seen();
    expect(all).toContain(MESSAGES_ITEM_LINE); // the events and the list were read
    expect(all).not.toContain(SECRET);
    // The minted children (server-side, never listed) carry the call; their own approvals don't.
    const children = await r.h.broker.batchChildren(applied.approval?.id ?? "");
    expect(JSON.stringify(children.map((c) => [c.approval, c.summary]))).not.toContain(SECRET);
  });

  it("a send of a draft made from Messages names no recipients on the card", async () => {
    const r = applyRig();
    const d = r.draft("See you at 4", FROM_MESSAGES);
    const out = await r.applier.apply(
      {
        reviewId: r.night.id,
        items: [r.tick(d)],
        sends: [{ itemId: d.id, sendHash: d.send?.contentHash ?? "" }],
      },
      LOCAL,
    );
    const items = detailItems(out.issued?.approval);
    expect(items.map((i) => i.summary)).toEqual([MESSAGES_ITEM_LINE, MESSAGES_ITEM_LINE]);
    expect(items[1]).toMatchObject({ withheld: "messages", send: {} });
    expect(JSON.stringify(out.issued?.approval)).not.toContain("ann@x.com");
    if (out.issued === undefined) throw new Error("no approval");
    await r.approve(out.issued);
    expect(r.ran.map((x) => x.tool)).toEqual(["mail_draft", "mail_send_draft"]);
  });

  it("control: a mail-tainted item keeps its own summary and recipients, and a remote device may apply it", async () => {
    const { r, handlers, seen } = leakRig();
    const d = r.draft();
    const out = await handlers["nightShift.apply"](
      {
        reviewId: r.night.id,
        items: [r.tick(d)],
        sends: [{ itemId: d.id, sendHash: d.send?.contentHash ?? "" }],
      },
      { surface: "desktop", local: false },
    );
    expect(out.refused).toEqual([]);
    const items = detailItems(out.approval);
    expect(items[0]).toMatchObject({ summary: d.summary });
    expect(items[0]?.withheld).toBeUndefined();
    expect(items[1]).toMatchObject({ send: { to: RECIPIENTS } });
    expect(await seen()).toContain(d.summary);
  });
});

describe("an unclear failure is uncertain, never back to ready", () => {
  const run = async (err: Error) => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    r.throwWith.set(a.id, err);
    const out = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    if (out.issued === undefined) throw new Error("no approval");
    await r.approve(out.issued);
    return r.item(a.id).status;
  };

  it.each([
    [
      "a helper timeout",
      new PsycheError("unavailable", "Reminders: reminders.create took too long", {
        details: { capability: "reminders.create", helperCode: "timeout", reason: "timeout" },
      }),
    ],
    [
      "a helper error of unknown kind",
      new PsycheError("unavailable", "Reminders: the helper refused", {
        details: { capability: "reminders.create", helperCode: "unknown" },
      }),
    ],
    [
      "a Google 5xx",
      new PsycheError("unavailable", "Google tasks.insert failed: 503", {
        details: { status: 503, reason: null },
        retryable: true,
      }),
    ],
  ])("%s is uncertain", async (_n, err) => {
    expect(await run(err)).toBe("uncertain");
  });

  it.each([
    [
      "the connector isn't connected",
      new PsycheError("unavailable", "connector apple is not connected"),
    ],
    [
      "macOS access never granted",
      new PsycheError("unavailable", "Reminders: not allowed", {
        details: {
          helperCode: "permission_denied",
          missing: { need: "macos_access", connector: "apple", reason: "permission_denied" },
        },
      }),
    ],
    [
      "the helper's own binding refusal",
      new PsycheError("unavailable", "Reminders: changed", {
        details: { helperCode: "binding_mismatch", reason: "changed" },
      }),
    ],
  ])("control: %s is before the effect (ready again)", async (_n, err) => {
    expect(await run(err)).toBe("ready");
  });
});

describe("undo: checked again at run time, money words allowed", () => {
  it("a reminder edited after the undo card was issued is not deleted", async () => {
    const r = applyRig();
    const a = r.reminder("Call the dentist");
    const out = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    if (out.issued === undefined) throw new Error("no approval");
    await r.approve(out.issued);
    const undo = await r.applier.undo([a.id]);
    if (undo.issued === undefined) throw new Error("no undo approval");
    r.inverseStale.add(a.targetKey); // the owner edits the reminder while the card is open
    await r.approve(undo.issued);
    expect(r.ran.map((x) => x.tool)).toEqual(["reminders_create"]);
    expect(r.item(a.id)).toMatchObject({ status: "applied", approvalId: null });
    expect(r.item(a.id).result?.error).toContain("undo refused: changed since it was applied");
  });

  it("undoes a reminder with money words (Undo: Pay rent $1,200)", async () => {
    const r = applyRig();
    const a = r.reminder("Pay rent $1,200");
    const out = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    expect(out.refused).toEqual([]);
    if (out.issued === undefined) throw new Error("no approval");
    await r.approve(out.issued);
    const undo = await r.applier.undo([a.id]);
    expect(undo.refused).toEqual([]);
    if (undo.issued === undefined) throw new Error("no undo approval");
    await r.approve(undo.issued);
    expect(r.ran.at(-1)).toMatchObject({ tool: "reminders_delete", params: { id: "rem_1" } });
    expect(r.item(a.id).status).toBe("undone");
  });
});

describe("the card reaches the paired iPhone (design §5.2: iOS answers like approveSuggestion)", () => {
  it("W5's surfaces put a staged_apply card on every paired device, with its own token", async () => {
    const r = applyRig({
      broker: { deviceSurfaces: () => ["desktop", "device:dev_phone"] },
      surfaces: null,
    });
    const a = r.reminder("Call the dentist");
    const out = await r.applier.apply({ reviewId: r.night.id, items: [r.tick(a)], sends: [] });
    expect(out.issued?.approval.surfaces).toContain("device:dev_phone");
    expect(out.issued?.answerTokens["device:dev_phone"]).toEqual(expect.any(String));
  });
});
