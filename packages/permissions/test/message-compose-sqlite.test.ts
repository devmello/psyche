import { FakeClock } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import {
  bodySha256,
  type ComposeCandidate,
  type ComposeDetails,
  composeBindingHash,
  readFinal,
} from "../src/index.ts";
import { DEVICE, memoryDb, sqliteBroker } from "./helpers.ts";

/**
 * The compose card on the Gateway's real SQLite store: the owner's edited text and chosen
 * recipient are what the approval binds, after a reload from the store and after a restart.
 */

const ACCOUNT = "mac-messages";
const DRAFT = "running late";
const mom: ComposeCandidate = {
  id: "handle:+15550001:imessage",
  kind: "handle",
  recipient: "+15550001",
  label: "Mom · +15550001",
  service: "imessage",
  weak: false,
};
const mom2: ComposeCandidate = {
  ...mom,
  id: "handle:+15550002:sms",
  recipient: "+15550002",
  service: "sms",
};

async function asked() {
  const db = memoryDb();
  const clock = new FakeClock();
  const broker = sqliteBroker(db, clock);
  const compose: ComposeDetails = {
    channel: "imessage",
    account: ACCOUNT,
    candidates: [mom, mom2],
    text: DRAFT,
    draftSha256: bodySha256(DRAFT),
    recipientSource: "owner",
  };
  const issued = await broker.requestApproval({
    kind: "message_send",
    summary: "Send a message",
    details: { channel: "imessage", account: ACCOUNT, recipient: mom.label, compose },
    bindingHash: composeBindingHash(ACCOUNT, mom.recipient, DRAFT),
    grantKey: "message_send|imessage|x",
    requestedBy: { runId: "run_1", taskId: null, threadId: "thr_a" },
    sideEffect: "destructive",
    surfaces: ["desktop"],
    scopesOffered: ["once"],
    taint: false,
  });
  clock.advance(500);
  const done = await broker.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop ?? "",
    decision: "approve",
    scope: "once",
    editedText: "on my way",
    recipientChoice: mom2.id,
    decidedBy: DEVICE,
  });
  return { db, clock, broker, issued, done };
}

const EDITED = () => composeBindingHash(ACCOUNT, mom2.recipient, "on my way");
const DRAFTED = () => composeBindingHash(ACCOUNT, mom.recipient, DRAFT);

describe("compose card on the SQLite store", () => {
  it("a reload from the store keeps the edited binding and details", async () => {
    const x = await asked();
    const reloaded = await x.broker.get(x.done.id);
    expect(reloaded?.bindingHash).toBe(EDITED());
    expect(readFinal(reloaded?.details ?? {})).toMatchObject({
      recipient: mom2.recipient,
      text: "on my way",
      edited: true,
    });
  });

  it("only the edited message verifies; the agent's draft never does", async () => {
    const x = await asked();
    expect(await x.broker.verifyBinding(x.done.id, DRAFTED())).toMatchObject({ ok: false });
    expect(await x.broker.verifyBinding(x.done.id, EDITED())).toMatchObject({ ok: true });
  });

  it("fails closed: a stored card that lost the owner's edit (the old store) never verifies", async () => {
    const x = await asked();
    // What the store wrote before the fix: the draft's details and binding, status approved.
    x.db.sqlite
      .prepare("UPDATE approvals SET details = ?, binding_hash = ? WHERE id = ?")
      .run(JSON.stringify(x.issued.approval.details), DRAFTED(), x.done.id);
    const other = sqliteBroker(x.db, x.clock);
    expect(await other.verifyBinding(x.done.id, DRAFTED())).toMatchObject({
      ok: false,
      reason: "binding_mismatch",
    });
    // And a final text whose hash is not the stored one.
    x.db.sqlite
      .prepare("UPDATE approvals SET details = ?, binding_hash = ? WHERE id = ?")
      .run(JSON.stringify({ ...x.done.details }), DRAFTED(), x.done.id);
    expect(await other.verifyBinding(x.done.id, DRAFTED())).toMatchObject({ ok: false });
  });

  it("another broker on the same database (a reload) reads the edited card", async () => {
    const x = await asked();
    const other = sqliteBroker(x.db, x.clock);
    const card = await other.get(x.done.id);
    expect(card?.bindingHash).toBe(EDITED());
    expect(readFinal(card?.details ?? {})).toMatchObject({ recipient: mom2.recipient });
    expect(await other.verifyBinding(x.done.id, DRAFTED())).toMatchObject({ ok: false });
  });
});
