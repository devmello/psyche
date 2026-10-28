import { describe, expect, it } from "vitest";
import {
  bodySha256,
  type ComposeCandidate,
  type ComposeDetails,
  composeBindingHash,
  readFinal,
} from "../src/index.ts";
import { DEVICE, makeBroker } from "./helpers.ts";

/** The `messages_send` compose card: the owner's pick and edited text are what the approval binds. */

const ACCOUNT = "mac-messages";
const DRAFT = "running late\nsee you at 6";
const mom: ComposeCandidate = {
  id: "handle:+15550001:imessage",
  kind: "handle" as const,
  recipient: "+15550001",
  label: "Mom · +15550001",
  service: "imessage" as const,
  weak: false,
};
const mom2 = {
  ...mom,
  id: "handle:+15550002:sms",
  recipient: "+15550002",
  service: "sms" as const,
};

async function ask(candidates: ComposeCandidate[], taint = false) {
  const h = makeBroker();
  const compose: ComposeDetails = {
    channel: "imessage",
    account: ACCOUNT,
    candidates,
    text: DRAFT.replace("\n", "⏎"),
    draftSha256: bodySha256(DRAFT),
    recipientSource: taint ? "untrusted" : "owner",
  };
  const first = candidates[0] ?? mom;
  const issued = await h.broker.requestApproval({
    kind: "message_send",
    summary: "Send a message",
    details: { channel: "imessage", account: ACCOUNT, recipient: first.label, compose },
    bindingHash: composeBindingHash(ACCOUNT, first.recipient, DRAFT),
    grantKey: "message_send|imessage|x",
    requestedBy: { runId: "run_1", taskId: null, threadId: "thr_a" },
    sideEffect: "destructive",
    surfaces: ["desktop"],
    scopesOffered: ["once"],
    taint,
  });
  h.clock.advance(500);
  return { h, issued };
}

const answer = (
  x: Awaited<ReturnType<typeof ask>>,
  extra: { editedText?: string; recipientChoice?: string },
  scope: "once" | "always" = "once",
) =>
  x.h.broker.answer({
    approvalId: x.issued.approval.id,
    answerToken: x.issued.answerTokens.desktop ?? "",
    decision: "approve",
    scope,
    ...extra,
    decidedBy: DEVICE,
  });

describe("message_send compose card", () => {
  it("binds the edited text and the chosen recipient, spent once", async () => {
    const x = await ask([mom, mom2]);
    const done = await answer(x, { editedText: "on my way", recipientChoice: mom2.id });
    const final = readFinal(done.details);
    expect(final).toMatchObject({ recipient: "+15550002", text: "on my way", edited: true });
    const want = composeBindingHash(ACCOUNT, "+15550002", "on my way");
    expect(await x.h.broker.verifyBinding(done.id, want)).toMatchObject({ ok: true });
    expect(await x.h.broker.verifyBinding(done.id, want)).toMatchObject({
      ok: false,
      reason: "consumed",
    });
  });

  it("rejects the agent's draft or another recipient against the edited approval", async () => {
    const x = await ask([mom]);
    const done = await answer(x, { editedText: "edited" });
    const draft = composeBindingHash(ACCOUNT, "+15550001", DRAFT);
    expect(await x.h.broker.verifyBinding(done.id, draft)).toMatchObject({
      ok: false,
      reason: "binding_mismatch",
    });
    const other = composeBindingHash(ACCOUNT, "+15559999", "edited");
    expect(await x.h.broker.verifyBinding(done.id, other)).toMatchObject({
      ok: false,
      reason: "binding_mismatch",
    });
  });

  it("an unedited answer is not marked edited", async () => {
    const x = await ask([mom]);
    const done = await answer(x, { editedText: DRAFT });
    expect(readFinal(done.details)?.edited).toBe(false);
  });

  it("refuses without a recipient choice among several, or one not on the card", async () => {
    const x = await ask([mom, mom2]);
    await expect(answer(x, { editedText: "hi" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      answer(x, { editedText: "hi", recipientChoice: "handle:+1999" }),
    ).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("refuses empty text, and any scope but once", async () => {
    const x = await ask([mom]);
    await expect(answer(x, { editedText: "   " })).rejects.toMatchObject({
      code: "invalid_params",
    });
    await expect(answer(x, { editedText: "hi" }, "always")).rejects.toBeDefined();
  });

  it("a tainted card offers once only", async () => {
    const x = await ask([mom], true);
    expect(x.issued.approval.scopesOffered).toEqual(["once"]);
  });
});
