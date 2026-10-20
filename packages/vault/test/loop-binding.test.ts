/**
 * A fill the agent loop approved (G4): the approval binds the loop's envelope over the tool call
 * (`toolCallBindingHash`, the one recipe every verifier shares). The vault recomputes it from the
 * fill it resolves and the broker's record, never from a hash the caller hands it, and fills at
 * most once per `once` approval even though the loop already consumed it at the broker.
 */
import { toolCallBindingHash } from "@psyche/protocol/binding";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, makeHarness, PASSWORD_FIELD } from "./helpers.ts";

const SECRET = "loop-bound-github-password";
const GH = { kind: "origin" as const, value: "https://github.com" };
const TOOL = "browser.fill_credential";
const PARAMS = { tabId: "t1", ref: "ref_2", placeholder: "{{cred:github-login.password}}" };
const OPTS = { executor: "browser" as const, element: PASSWORD_FIELD, selector: "ref_2" };

let h: Harness;
let itemId = "";
beforeEach(async () => {
  h = makeHarness();
  await h.vault.setup();
  itemId = (
    await h.vault.add({
      kind: "login",
      name: "github-login",
      bindings: [{ origin: GH.value }],
      secret: { username: "owner", password: SECRET },
    })
  ).id;
});
afterEach(() => h.cleanup());

/** What the browser's `describe()` binds for this fill (same shape as the vault's fields). */
function fields(over: Record<string, unknown> = {}) {
  return {
    executor: "browser",
    field: "password",
    itemId,
    target: GH.value,
    selector: "ref_2",
    element: { autocomplete: "current-password", tagName: "input", type: "password" },
    ...over,
  };
}

/** The loop's approval for one call, answered and (optionally) consumed as the loop does. */
async function loopApproval(
  opts: { params?: unknown; bound?: unknown; consume?: boolean } = {},
): Promise<string> {
  const bindingHash = toolCallBindingHash(TOOL, opts.params ?? PARAMS, {
    kind: "credential_fill",
    bindingFields: opts.bound ?? fields(),
  });
  const issued = await h.permissions.requestApproval({
    kind: "credential_fill",
    summary: "Fill a saved credential on https://github.com",
    details: {},
    bindingHash,
    grantKey: `${TOOL}|credential_fill|${itemId}|${GH.value}|password|browser`,
    requestedBy: { runId: "run1", taskId: null, threadId: "th1", toolCallId: "c3" },
    sideEffect: "write",
    targetKind: "origin",
    target: GH,
    surfaces: ["desktop"],
    scopesOffered: ["once"],
    taint: false,
  });
  h.clock.advance(500);
  await h.permissions.answer({
    approvalId: issued.approval.id,
    answerToken: issued.answerTokens.desktop as string,
    decision: "approve",
    scope: "once",
    decidedBy: { deviceId: "dev_desktop", surface: "desktop" },
  });
  if (opts.consume !== false) {
    expect(await h.permissions.verifyBinding(issued.approval.id, bindingHash)).toMatchObject({
      ok: true,
    });
  }
  return issued.approval.id;
}

const call = (over: Partial<{ tool: string; params: unknown; toolCallId: string }> = {}) => ({
  tool: TOOL,
  params: PARAMS,
  toolCallId: "c3",
  ...over,
});

describe("loop-approved fills (G4)", () => {
  it("fills once under the loop's consumed approval, then refuses a replay", async () => {
    const id = await loopApproval();
    const secret = await h.vault.resolve(PARAMS.placeholder, GH, id, { ...OPTS, call: call() });
    secret.use((v) => expect(v).toBe(SECRET));
    await expect(
      h.vault.resolve(PARAMS.placeholder, GH, id, { ...OPTS, call: call() }),
    ).rejects.toMatchObject({
      code: "approval_required",
      details: { reason: "approval_consumed" },
    });
  });

  it("also fills once when nothing consumed the approval first", async () => {
    const id = await loopApproval({ consume: false });
    (await h.vault.resolve(PARAMS.placeholder, GH, id, { ...OPTS, call: call() })).dispose();
    await expect(
      h.vault.resolve(PARAMS.placeholder, GH, id, { ...OPTS, call: call() }),
    ).rejects.toMatchObject({ details: { reason: "approval_consumed" } });
  });

  it("refuses when the call's arguments differ from what was approved (tab id included)", async () => {
    const id = await loopApproval();
    await expect(
      h.vault.resolve(PARAMS.placeholder, GH, id, {
        ...OPTS,
        call: call({ params: { ...PARAMS, tabId: "t2" } }),
      }),
    ).rejects.toMatchObject({ details: { reason: "approval_binding_mismatch" } });
  });

  it("refuses when the live element differs from the approved one", async () => {
    const id = await loopApproval();
    await expect(
      h.vault.resolve(PARAMS.placeholder, GH, id, {
        ...OPTS,
        element: { ...PASSWORD_FIELD, autocomplete: "new-password" },
        call: call(),
      }),
    ).rejects.toMatchObject({ details: { reason: "approval_binding_mismatch" } });
  });

  it("refuses an approval bound to another item or without the call envelope", async () => {
    const other = await loopApproval({ bound: fields({ itemId: "cred_other" }) });
    await expect(
      h.vault.resolve(PARAMS.placeholder, GH, other, { ...OPTS, call: call() }),
    ).rejects.toMatchObject({ details: { reason: "approval_binding_mismatch" } });
    const id = await loopApproval({ consume: false });
    // The bare fill fields are a different binding from the loop's envelope.
    await expect(h.vault.resolve(PARAMS.placeholder, GH, id, OPTS)).rejects.toMatchObject({
      details: { reason: "approval_binding_mismatch" },
    });
  });

  it("refuses another tool call's approval", async () => {
    const id = await loopApproval();
    await expect(
      h.vault.resolve(PARAMS.placeholder, GH, id, { ...OPTS, call: call({ toolCallId: "c9" }) }),
    ).rejects.toMatchObject({ details: { reason: "approval_another_call" } });
  });
});
