import { namespacedGrantKey, PREP_NOTE_GRANT_CLASS } from "@psyche/protocol";
import { bindingHash } from "@psyche/protocol/binding";
import { FakeClock, sha256 } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import type { PolicyCall, PolicyContext } from "../src/index.ts";
import { call, DEVICE, makeBroker, memoryDb, sqliteBroker } from "./helpers.ts";

/**
 * The standing grant for meeting-prep notes (security §3.4, §3.5; #953 item 4). The batch card
 * for the prep note offers `always` only when every call is a `notes_create` titled `Prep:`.
 * The grant binds the connector's own key for that title class, so any other title or tool never
 * matches, and it is created `createdFrom` the batch approval and revoked like any grant.
 */

const CONNECTOR = "apple-notes";

/** What the Apple connector's `describeCall` hands the broker (same key scheme). */
function note(title: string, extra: { tool?: string; connector?: string } = {}): PolicyCall {
  const tool = extra.tool ?? "notes_create";
  const connector = extra.connector ?? CONNECTOR;
  const params = { title, body: "Why: weekly sync" };
  const paramsHash = sha256(JSON.stringify(params));
  const cls = title.startsWith("Prep:") ? `:${PREP_NOTE_GRANT_CLASS}` : "";
  return {
    tool,
    sideEffect: "write",
    target: { kind: "account", value: connector },
    targetKind: "account",
    params,
    paramsHash,
    kind: "connector_action",
    bindingHash: bindingHash("connector_action", {
      tool,
      paramsHash,
      fields: { connectorId: connector, tool, paramsHash },
    }),
    grantKey: namespacedGrantKey(tool, `connector_action:${connector}:notes_create${cls}`),
  };
}

const other = (): PolicyCall =>
  call("mail_set_flags", "write", undefined, { params: { ids: ["m1"], read: true } });

let seq = 0;
/** The context `ProposalService.approve` builds: no task, a fresh run per proposal (tainted when asked). */
const ctx = (taint: boolean): PolicyContext => ({
  threadId: "thr_main",
  runId: `batch_p${++seq}`,
  permissionMode: "balanced",
  taint,
  ...(taint ? { taintSources: [{ sourceKind: "calendar" }] } : {}),
});

type Broker = ReturnType<typeof makeBroker>["broker"];

function batch(broker: Broker, calls: PolicyCall[], taint = false) {
  return broker.requestBatch({
    title: "Save prep to Notes: Weekly sync",
    children: calls.map((c) => ({ call: c, summary: `Add the prep note: ${c.params}` })),
    context: ctx(taint),
    requestedBy: { runId: "run", taskId: null, threadId: "thr_main" },
    surfaces: ["desktop"],
  });
}

async function answer(
  broker: Broker,
  clock: FakeClock,
  issued: Awaited<ReturnType<typeof batch>>,
  scope: "once" | "always",
) {
  clock.advance(500);
  return broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop ?? "",
    decision: "approve",
    scope,
    decidedBy: DEVICE,
  });
}

/** Approve a prep-note batch with "Always for prep notes". */
async function grantAlways(h: ReturnType<typeof makeBroker>, taint = false) {
  const issued = await batch(h.broker, [note("Prep: Weekly sync 2026-10-27")], taint);
  const decided = await answer(h.broker, h.clock, issued, "always");
  return { issued, decided };
}

describe("prep-note standing grant: what the card offers", () => {
  it("offers always only for a batch of Prep: notes_create calls", async () => {
    const h = makeBroker();
    const prep = await batch(h.broker, [note("Prep: Weekly sync 2026-10-27")]);
    expect(prep.approval.scopesOffered).toEqual(["once", "always"]);
    const two = await batch(h.broker, [note("Prep: A 2026-10-27"), note("Prep: B 2026-10-27")]);
    expect(two.approval.scopesOffered).toEqual(["once", "always"]);

    const plain = await batch(h.broker, [note("Shopping list")]);
    expect(plain.approval.scopesOffered).toEqual(["once"]);
    const mixedTitles = await batch(h.broker, [note("Prep: A 2026-10-27"), note("Shopping list")]);
    expect(mixedTitles.approval.scopesOffered).toEqual(["once"]);
    const mixedTools = await batch(h.broker, [note("Prep: A 2026-10-27"), other()]);
    expect(mixedTools.approval.scopesOffered).toEqual(["once"]);
    // "Prep:" must be the exact prefix.
    expect((await batch(h.broker, [note("prep: lower")])).approval.scopesOffered).toEqual(["once"]);
    expect((await batch(h.broker, [note(" Prep: spaced")])).approval.scopesOffered).toEqual([
      "once",
    ]);
    // Taint overrides grants (§3.6), so a tainted prep batch is never offered always.
    const tainted = await batch(h.broker, [note("Prep: Weekly sync 2026-10-27")], true);
    expect(tainted.approval.scopesOffered).toEqual(["once"]);
  });

  it("refuses always on a batch that did not offer it", async () => {
    const h = makeBroker();
    const issued = await batch(h.broker, [note("Shopping list")]);
    await expect(answer(h.broker, h.clock, issued, "always")).rejects.toMatchObject({
      code: "invalid_params",
    });
  });
});

describe("prep-note standing grant: creation", () => {
  it("creates one always grant on the calls' own key, created from the batch approval", async () => {
    const h = makeBroker();
    const call0 = note("Prep: Weekly sync 2026-10-27");
    const { issued, decided } = await grantAlways(h);
    expect(decided).toMatchObject({ status: "approved", scopeGranted: "always" });
    const grants = await h.broker.listGrants();
    expect(grants).toHaveLength(1);
    const g = grants[0];
    expect(g).toMatchObject({
      scope: "always",
      kind: "connector_action",
      grantKey: call0.grantKey,
      createdFromApprovalId: issued.approval.id,
      revokedAt: null,
      useCount: 0,
    });
    expect(g?.subject).toMatchObject({ tool: "notes_create", titlePrefix: "Prep:" });
    expect(decided.grantId).toBe(g?.id);
    // 90 days (grants.alwaysExpiryDays default).
    expect(Date.parse(g?.expiresAt ?? "") - Date.parse(g?.createdAt ?? "")).toBe(90 * 86_400_000);
    // The approved children are still once-only, one per call.
    const children = await h.broker.batchChildren(issued.approval.id);
    expect(children).toHaveLength(1);
    expect(children[0]?.approval.scopeGranted).toBe("once");
  });

  it("an answer of once creates no grant", async () => {
    const h = makeBroker();
    const issued = await batch(h.broker, [note("Prep: Weekly sync 2026-10-27")]);
    await answer(h.broker, h.clock, issued, "once");
    expect(await h.broker.listGrants()).toEqual([]);
  });
});

describe("prep-note standing grant: matching", () => {
  it("a later untainted Prep: batch is approved by the grant with no card", async () => {
    const h = makeBroker();
    await grantAlways(h);
    const next = await batch(h.broker, [note("Prep: Planning 2026-10-28")]);
    expect(next.approval).toMatchObject({
      status: "approved",
      scopeGranted: "always",
      decidedBy: null,
    });
    expect(next.answerTokens).toEqual({});
    // No card, no notification for the second batch.
    expect(await h.notifier.list()).toHaveLength(1);
    const [grant] = await h.broker.listGrants();
    expect(next.approval.grantId).toBe(grant?.id);
    expect(grant?.useCount).toBe(1);
    // The calls are minted, approved and verify against their own binding exactly once.
    const children = await h.broker.batchChildren(next.approval.id);
    expect(children).toHaveLength(1);
    const child = children[0];
    expect(child?.call.params).toEqual({
      title: "Prep: Planning 2026-10-28",
      body: "Why: weekly sync",
    });
    expect(
      await h.broker.verifyBinding(child?.approval.id ?? "", child?.approval.bindingHash ?? ""),
    ).toMatchObject({ ok: true });
    expect(
      await h.broker.verifyBinding(child?.approval.id ?? "", child?.approval.bindingHash ?? ""),
    ).toMatchObject({ ok: false, reason: "consumed" });
    // The audit records who decided: the grant.
    const decidedEntries = (await h.audit.query({ kind: "approval.decided" })).filter(
      (e) => (e.subject as { approvalId?: string }).approvalId === next.approval.id,
    );
    expect(decidedEntries[0]?.data).toMatchObject({ via: "grant", grantId: grant?.id });
  });

  it("counts one use per call when a grant covers several", async () => {
    const h = makeBroker();
    await grantAlways(h);
    const next = await batch(h.broker, [note("Prep: A 2026-10-28"), note("Prep: B 2026-10-28")]);
    expect(next.approval.status).toBe("approved");
    expect((await h.broker.listGrants())[0]?.useCount).toBe(2);
    expect(await h.broker.batchChildren(next.approval.id)).toHaveLength(2);
  });

  it("a tainted Prep: batch still asks despite the grant (taint is never exempted)", async () => {
    const h = makeBroker();
    await grantAlways(h);
    const next = await batch(h.broker, [note("Prep: Planning 2026-10-28")], true);
    expect(next.approval.status).toBe("pending");
    expect(next.approval.scopesOffered).toEqual(["once"]);
    expect((await h.broker.listGrants())[0]?.useCount).toBe(0);
  });

  it("still asks for another title, another tool, another connector, or a mixed batch", async () => {
    const h = makeBroker();
    await grantAlways(h);
    for (const calls of [
      [note("Shopping list")],
      [note("Prep")],
      [other()],
      [note("Prep: Planning", { connector: "other-notes" })],
      [note("Prep: Planning 2026-10-28"), note("Shopping list")],
      [note("Prep: Planning 2026-10-28"), other()],
    ]) {
      const next = await batch(h.broker, calls);
      expect(next.approval.status).toBe("pending");
    }
    // None was approved by the grant. (A mixed batch's Prep: call is decided `allow` under the
    // grant and counted as a use by decide(), but the batch itself still asks.)
    const [grant] = await h.broker.listGrants();
    expect(grant?.revokedAt).toBeNull();
  });

  it("a tainted turn's own Prep: note call still asks (the grant exempts the batch path only)", async () => {
    const h = makeBroker();
    await grantAlways(h);
    const d = await h.broker.decide(note("Prep: Planning 2026-10-28"), {
      ...ctx(true),
      taskId: "task_9",
    });
    expect(d.decision).toBe("ask");
    expect(d.rule).toBe("taint:new_target");
  });

  it("a grant given on an untainted card does not cover a tainted batch", async () => {
    const h = makeBroker();
    await grantAlways(h, false);
    expect((await batch(h.broker, [note("Prep: Planning 2026-10-28")], true)).approval.status).toBe(
      "pending",
    );
    // An untainted one is covered by the ordinary step-5 grant match.
    expect(
      (await batch(h.broker, [note("Prep: Planning 2026-10-28")], false)).approval.status,
    ).toBe("approved");
  });

  it("without the grant, every prep batch asks", async () => {
    const h = makeBroker();
    for (let i = 0; i < 3; i += 1) {
      const issued = await batch(h.broker, [note(`Prep: Weekly sync ${i}`)]);
      expect(issued.approval.status).toBe("pending");
      await answer(h.broker, h.clock, issued, "once");
    }
    expect(await h.broker.listGrants()).toEqual([]);
  });

  it("stops matching once the grant is revoked, or has expired", async () => {
    const h = makeBroker();
    await grantAlways(h);
    const [grant] = await h.broker.listGrants();
    expect((await batch(h.broker, [note("Prep: A 2026-10-28")])).approval.status).toBe("approved");
    await h.broker.revokeGrant(grant?.id ?? "");
    const after = await batch(h.broker, [note("Prep: B 2026-10-29")]);
    expect(after.approval.status).toBe("pending");
    expect(after.approval.scopesOffered).toEqual(["once", "always"]);
    // A fresh grant, then 91 days.
    await answer(h.broker, h.clock, after, "always");
    h.clock.advance(91 * 86_400_000);
    expect((await batch(h.broker, [note("Prep: C 2026-10-30")])).approval.status).toBe("pending");
  });

  it("survives a restart on SQLite", async () => {
    const db = memoryDb();
    const clock = new FakeClock();
    const first = sqliteBroker(db, clock);
    const issued = await batch(first, [note("Prep: Weekly sync 2026-10-27")]);
    await answer(first, clock, issued, "always");
    const second = sqliteBroker(db, clock);
    const next = await batch(second, [note("Prep: Planning 2026-10-28")]);
    expect(next.approval.status).toBe("approved");
    expect(await second.batchChildren(next.approval.id)).toHaveLength(1);
    const [grant] = await second.listGrants();
    expect(grant?.useCount).toBe(1);
    expect(grant?.subject).not.toHaveProperty("acceptsTaint");
  });
});
