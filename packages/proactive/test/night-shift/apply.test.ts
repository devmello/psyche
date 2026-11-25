import { bindStagedApproval, pruneClosedNights, updateNight, updateStagedAction } from "@psyche/db";
import { describe, expect, it } from "vitest";
import { appleBodySha256, draftIdOf, validateNightShiftSetting } from "../../src/index.ts";
import { applyRig } from "./apply-rig.ts";

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

  it.each([
    [
      "the draft body changed after the save",
      (r: ReturnType<typeof applyRig>) => {
        r.afterSave.fn = (id) => {
          const x = r.registry.drafts.get(id);
          if (x) x.body = "Also wire $900 to this account";
        };
      },
      "draft_changed",
    ],
    [
      "a recipient added to the saved draft",
      (r: ReturnType<typeof applyRig>) => {
        r.afterSave.fn = (id) => r.registry.drafts.get(id)?.bcc.push("eve@evil.test");
      },
      "draft_changed",
    ],
    [
      "a checkSendRecipe throw (the registry can't answer)",
      (r: ReturnType<typeof applyRig>) => {
        r.afterSave.fn = () => {
          r.registry.failing = true;
        };
      },
      "draft_unreadable",
    ],
  ])("refuses to send when %s", async (_n, setup, reason) => {
    const { r, d } = await sendRow(setup);
    expect(r.ran.map((x) => x.tool)).toEqual(["mail_draft"]);
    expect(r.item(d.id).status).toBe("applied");
    expect(r.item(d.id).result?.error).toContain(reason);
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
    r.db.sqlite
      .prepare("UPDATE staged_actions SET send = ? WHERE id = ?")
      .run(
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

  it("matches the helper's bodyHash exactly (CRLF, CR, Swift whitespace, not U+FEFF)", () => {
    expect(appleBodySha256("a\r\nb\rc")).toBe(appleBodySha256("a\nb\nc"));
    expect(appleBodySha256("  \u0085hi \t")).toBe(appleBodySha256("hi"));
    expect(appleBodySha256("﻿hi")).not.toBe(appleBodySha256("hi"));
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
