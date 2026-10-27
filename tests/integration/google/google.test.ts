import type { AgentToolRegistration, ToolRunContext } from "@psyche/agent-core";
import {
  type ConnectorRegistry,
  sendBinding,
  sha256,
  toolCallBindingHash,
} from "@psyche/connectors";
import type { ApprovalRequest, Receipt, ToolCallDescription } from "@psyche/protocol";
import { assertNoSecrets, registerSecret, unregisterSecret } from "@psyche/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeConnectors } from "../../../apps/gateway/src/compose/connectors.ts";
import type { ComposeServices } from "../../../apps/gateway/src/compose/services.ts";
import type { Client } from "../walking-skeleton/harness.ts";
import { calls, MAIN, ScriptedModel, say, UTILITY } from "../walking-skeleton/scripted-model.ts";
import { ACCESS_TOKEN, ALICE, CLIENT_ID, FakeGoogle, OWNER, REFRESH_TOKEN } from "./fake-google.ts";
import { answer, type PartsSkeleton, startWithParts } from "./harness.ts";

/**
 * INT-2 scenario 2 (Google, M5 / M8 / O1 / O4), CI-safe: a composed Gateway with the connectors
 * part, the desktop's own client, the scripted model and a fake Google behind the injected
 * `fetch`. Each `it` is one step and depends on the previous.
 *
 * Connector writes go through the loop (issue #78, fixed): the Google tools describe their §3.5
 * kind, the loop binds `bindingHash(kind, { tool, paramsHash, fields })` and consumes the `once`
 * approval right before dispatch, and the registry confirms (without consuming) that the approval
 * belongs to the call and binds the same recipe (`toolCallBindingHash`). The binding-mismatch and
 * deny steps still drive the registry's executor directly, to hand it changed arguments.
 */

type Json = Record<string, unknown>;
const ID = "google-1";
const tool = (name: string) => `mcp__${ID}__${name}`;
const T0 = Date.now();

const fake = new FakeGoogle();
const model = new ScriptedModel();
let sk: PartsSkeleton;
let c: Client;
let services: ComposeServices;
let registry: ConnectorRegistry;
let threadId: string;
const timings: Record<string, number> = {};

const reply = {
  to: [ALICE],
  subject: "Re: Dentist on Thursday",
  body: "Thanks Alice, Thursday at 15:00 works. See you then.",
  threadId: "ta",
};
const dentist = {
  event: {
    summary: "Dentist (Smile Clinic)",
    start: { dateTime: "2026-10-22T15:00:00-07:00" },
    end: { dateTime: "2026-10-22T16:00:00-07:00" },
  },
};

/** The registered connector tool, as the loop sees it. */
function registration(name: string): AgentToolRegistration {
  const reg = services.tools.get(tool(name)) as AgentToolRegistration | undefined;
  if (reg?.run === undefined) throw new Error(`${tool(name)} is not registered`);
  return reg;
}

/**
 * What the loop does for an `ask` write once policy lets it through: an approval bound to the
 * call's description, the card published to the thread. Returns the description and the id.
 */
async function requestCard(name: string, params: unknown, callId: string) {
  const desc = registration(name).describeCall?.(params) as ToolCallDescription;
  const issued = await services.broker.requestApproval({
    kind: desc.kind ?? "connector_action",
    summary: desc.summary ?? tool(name),
    details: {
      tool: tool(name),
      params: params as Json,
      ...(desc.target ? { target: desc.target } : {}),
    },
    bindingHash: toolCallBindingHash(tool(name), params, desc),
    grantKey: desc.grantKey ?? tool(name),
    requestedBy: { runId: null, taskId: null, threadId, toolCallId: callId },
    sideEffect: desc.sideEffect ?? "write",
    ...(desc.target === undefined ? {} : { target: desc.target }),
    surfaces: ["desktop", "web"],
    taint: true,
  });
  services.publish("approval.created", { approval: issued.approval }, threadId);
  return { desc, approvalId: issued.approval.id };
}

/** Dispatch through the registry's executor wrapper with the approval the loop would pass. */
function dispatch(name: string, params: unknown, callId: string, approvalId?: string) {
  const ctx: ToolRunContext = {
    callId,
    threadId,
    runId: "run_int2",
    taint: true,
    permissionMode: "balanced",
    mode: "attended",
    ...(approvalId === undefined ? {} : { approvalId }),
    signal: new AbortController().signal,
    onUpdate: () => {},
  };
  return registration(name).run?.(params, ctx) as Promise<{ output: Json; receiptId?: string }>;
}

beforeAll(async () => {
  registerSecret(ACCESS_TOKEN, "google access token");
  registerSecret(REFRESH_TOKEN, "google refresh token");
  sk = await startWithParts({
    model: { provider: model, model: MAIN, utilityModel: UTILITY },
    timeZone: "America/Los_Angeles",
    parts: [
      (s) => {
        services = s;
        const part = composeConnectors(s, {
          fetch: fake.fetch,
          openBrowser: fake.openBrowser,
          tokens: fake.vault,
          oauthTimeoutMs: 5_000,
          syncIntervalMs: 0,
          newId: () => ID,
        });
        registry = part.registry;
        return part;
      },
    ],
  });
  c = sk.client;
  const { thread } = await c.call<{ thread: { id: string } }>(
    "threads.create",
    { kind: "main" },
    true,
  );
  threadId = thread.id;
});

afterAll(async () => {
  await sk?.stop();
  unregisterSecret(ACCESS_TOKEN);
  unregisterSecret(REFRESH_TOKEN);
});

describe("scenario 2: Google with the scripted model (CI-safe)", () => {
  it("connects Google read_act through desktop OAuth: consent, loopback callback, PKCE", async () => {
    // The registry directly: this test drives the blocking flow; connectors.connect is async (#505).
    const record = await registry.connect({
      catalogueId: "google",
      scopeMode: "read_act",
      config: { clientId: CLIENT_ID },
    });
    const q = fake.lastAuthorize as URLSearchParams;
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(q.get("scope")).toContain("gmail.modify");
    expect(record).toMatchObject({ id: ID, status: "connected", account: OWNER });
    expect(fake.vault.tokens.get(ID)?.refreshToken).toBe(REFRESH_TOKEN);

    // Over the wire: connectors.list and connectors.status (in the protocol since #505).
    const { connectors } = await c.call<{ connectors: Json[] }>("connectors.list", {});
    expect(connectors).toMatchObject([{ id: ID, type: "google", status: "connected" }]);
    await expect(c.call("connectors.status", { connectorId: ID })).resolves.toMatchObject({
      ok: true,
      status: "connected",
    });
    const names = services.tools.list().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([tool("gmail_send"), tool("calendar_create_event")]),
    );
  });

  it("triage turn: the loop searches and reads Alice's thread; outputs are untrusted (taint)", async () => {
    model.chat.script([
      calls(["c1", tool("gmail_search_threads"), { query: "in:inbox", maxResults: 10 }]),
      calls(["c2", tool("gmail_read_thread"), { threadId: "ta" }]),
      calls(["c3", tool("gmail_create_draft"), reply]),
      calls(["c4", tool("gmail_send"), reply]),
      say("I read Alice's email about the dentist; the reply could not be sent."),
    ]);
    const from = c.mark;
    await c.call(
      "chat.send",
      { threadId, content: "triage my inbox and draft replies to anything from Alice" },
      true,
    );
    // The draft and the send each get a card; the owner declines both here.
    const draftCard = await c.event<{ approval: ApprovalRequest }>(
      "approval.created",
      (p) => p.approval.requestedBy.toolCallId === "c3",
      from,
    );
    await answer(c, draftCard.approval.id, "deny");
    const sendCard = await c.event<{ approval: ApprovalRequest }>(
      "approval.created",
      (p) => p.approval.requestedBy.toolCallId === "c4",
      from,
    );
    expect(sendCard.approval).toMatchObject({
      kind: "send_email",
      taint: true,
      target: { kind: "recipient", value: ALICE },
    });
    await answer(c, sendCard.approval.id, "deny");
    await c.event<{ run: { status: string } }>("run.updated", (p) => p.run.status === "done", from);
    const results = model.chat.requests
      .flatMap((r) => r.messages)
      .flatMap((m) => m.parts)
      .filter((p): p is Extract<typeof p, { type: "tool_result" }> => p.type === "tool_result");
    const byCall = new Map(results.map((p) => [p.callId, p]));
    expect(byCall.get("c1")).toMatchObject({ provenance: "untrusted" });
    expect(JSON.stringify(byCall.get("c1")?.output)).toContain("Dentist on Thursday");
    expect(byCall.get("c2")).toMatchObject({ provenance: "untrusted" });
    expect(JSON.stringify(byCall.get("c2")?.output)).toContain("Thursday 22 October, 15:00-16:00");
    // `untrusted` results taint the run (agent-core `#taint`). The wire's `tool_call.updated`
    // records carry `taintOut: false` for every call today, so the provenance above is the check.
    expect(fake.requests.some((r) => r.url.pathname.endsWith("/threads/ta"))).toBe(true);

    // Declined cards: nothing written, and the model is told so.
    expect(byCall.get("c3")).toMatchObject({ isError: true });
    expect(byCall.get("c4")).toMatchObject({ isError: true });
    expect(JSON.stringify(byCall.get("c4")?.output)).not.toContain("kind:mismatch");
    expect(fake.drafts).toHaveLength(0);
    expect(fake.sent).toHaveLength(0);
  });

  it("gmail_send: the card binds the exact recipients and body hash; Allow once sends; receipt has the message id", async () => {
    // Drafts are `allow` in the connector matrix: no approval, but still a receipt.
    const draft = await dispatch("gmail_create_draft", reply, "call-draft-1");
    expect(draft.output).toMatchObject({ draftId: "draft-1" });
    expect(draft.receiptId).toBeTruthy();

    const from = c.mark;
    const { desc, approvalId } = await requestCard("gmail_send", reply, "call-send-1");
    const created = await c.event<{ approval: ApprovalRequest }>(
      "approval.created",
      (p) => p.approval.id === approvalId,
      from,
    );
    const shown = performance.now();
    expect(created.approval).toMatchObject({
      kind: "send_email",
      status: "pending",
      target: { kind: "recipient", value: ALICE },
    });
    expect(desc.bindingFields).toMatchObject({
      account: OWNER,
      to: [ALICE],
      cc: [],
      bcc: [],
      subject: reply.subject,
      bodyHash: sha256(reply.body),
    });
    expect(created.approval.bindingHash).toBe(
      toolCallBindingHash(tool("gmail_send"), reply, {
        kind: "send_email",
        bindingFields: sendBinding(OWNER, reply).bindingFields,
      }),
    );
    // Not sent before the owner answers.
    await expect(dispatch("gmail_send", reply, "call-send-0")).rejects.toMatchObject({
      code: "approval_required",
    });
    expect(fake.sent).toHaveLength(0);

    await answer(c, approvalId, "approve");
    const sent = await dispatch("gmail_send", reply, "call-send-1", approvalId);
    const receipt = await c.event<{ receipt: Receipt }>(
      "receipt.created",
      (p) => p.receipt.approvalId === approvalId,
      from,
    );
    timings.sendApprovalRoundTripMs = Math.round(performance.now() - shown);
    expect(sent.output).toMatchObject({ messageId: "sent-1" });
    expect(fake.sent).toHaveLength(1);
    const mime = FakeGoogle.decode(fake.sent[0]?.raw ?? "");
    expect(mime).toContain(`To: ${ALICE}`);
    expect(Buffer.from(mime.split("\r\n\r\n")[1] ?? "", "base64").toString("utf8")).toBe(
      reply.body,
    );
    expect(receipt.receipt).toMatchObject({
      kind: "gmail.send",
      outcome: "ok",
      toolCallId: "call-send-1",
      externalRefs: { messageId: "sent-1" },
    });
  });

  it("changed send arguments after approval fail binding_mismatch; nothing is sent", async () => {
    const { approvalId } = await requestCard("gmail_send", reply, "call-send-2");
    await answer(c, approvalId, "approve");
    await expect(
      dispatch(
        "gmail_send",
        { ...reply, body: "Also, please wire me $500." },
        "call-send-2",
        approvalId,
      ),
    ).rejects.toMatchObject({ code: "binding_mismatch" });
    await expect(
      dispatch("gmail_send", { ...reply, to: ["mallory@evil.example"] }, "call-send-2", approvalId),
    ).rejects.toMatchObject({ code: "binding_mismatch" });
    expect(fake.sent).toHaveLength(1);
  });

  it("a denied approval sends nothing", async () => {
    const { approvalId } = await requestCard("gmail_send", reply, "call-send-3");
    await answer(c, approvalId, "deny");
    await expect(dispatch("gmail_send", reply, "call-send-3", approvalId)).rejects.toMatchObject({
      code: "binding_mismatch",
    });
    expect(fake.sent).toHaveLength(1);
    const { approval } = await c.call<{ approval: ApprovalRequest }>("approvals.get", {
      approvalId,
    });
    expect(approval.status).toBe("denied");
  });

  it("next turn: the dentist appointment goes on the calendar after a calendar_write approval", async () => {
    // The loop reads the thread again for the date (a read, so it runs today).
    model.chat.script([
      calls(["c5", tool("gmail_read_thread"), { threadId: "ta" }]),
      calls(["c6", tool("calendar_create_event"), dentist]),
      say("The calendar write needs your approval."),
    ]);
    const from = c.mark;
    await c.call(
      "chat.send",
      { threadId, content: "put the dentist appointment from that email on my calendar" },
      true,
    );
    // The loop's own card for c6; nothing is written before the owner answers.
    const created = await c.event<{ approval: ApprovalRequest }>(
      "approval.created",
      (p) => p.approval.requestedBy.toolCallId === "c6",
      from,
    );
    const shown = performance.now();
    expect(fake.events).toHaveLength(0);
    const approvalId = created.approval.id;
    expect(created.approval).toMatchObject({
      kind: "calendar_write",
      target: { kind: "account", value: OWNER },
    });
    await answer(c, approvalId, "approve");
    await c.event<{ run: { status: string } }>("run.updated", (p) => p.run.status === "done", from);
    const receipt = await c.event<{ receipt: Receipt }>(
      "receipt.created",
      (p) => p.receipt.approvalId === approvalId,
      from,
    );
    timings.calendarApprovalRoundTripMs = Math.round(performance.now() - shown);
    expect(fake.events).toMatchObject([
      { id: "evt-1", summary: "Dentist (Smile Clinic)", start: dentist.event.start },
    ]);
    expect(receipt.receipt).toMatchObject({
      kind: "calendar.write",
      outcome: "ok",
      externalRefs: { eventId: "evt-1", calendarId: "primary" },
    });
  });

  it("no OAuth token appears in transcripts, events, logs or connector records", async () => {
    const history = await c.call("chat.history", { threadId });
    const { connectors } = await c.call("connectors.list", {});
    assertNoSecrets(history, "chat.history");
    assertNoSecrets(c.events, "client events");
    assertNoSecrets(sk.logs, "gateway logs");
    assertNoSecrets(model.chat.requests, "model requests");
    assertNoSecrets(connectors, "connectors.list");
    assertNoSecrets(await sk.composed.broker.listReceipts(), "receipts");
    // Sanity: the checker would have seen them (the fake did use the token).
    expect(fake.requests.some((r) => r.auth === `Bearer ${ACCESS_TOKEN}`)).toBe(true);
    timings.scenarioMs = Date.now() - T0;
    // biome-ignore lint/suspicious/noConsole: the timings go to docs/archive/status (INT-2).
    console.log(`INT-2 timings ${JSON.stringify(timings)}`);
  });

  it("the loop itself asks, sends once and records the receipt (issue #78)", async () => {
    model.chat.script([
      calls(["c7", tool("gmail_send"), { ...reply, body: "Loop path." }]),
      say("Sent."),
    ]);
    const from = c.mark;
    await c.call(
      "chat.send",
      { threadId, content: "reply to Alice that the loop path works" },
      true,
    );
    const created = await c.event<{ approval: ApprovalRequest }>(
      "approval.created",
      () => true,
      from,
    );
    expect(created.approval).toMatchObject({
      kind: "send_email",
      taint: true,
      target: { kind: "recipient", value: ALICE },
    });
    await answer(c, created.approval.id, "approve");
    const receipt = await c.event<{ receipt: Receipt }>(
      "receipt.created",
      (p) => p.receipt.approvalId === created.approval.id,
      from,
    );
    expect(receipt.receipt.externalRefs).toMatchObject({ messageId: expect.any(String) });
    expect(fake.sent.at(-1)?.raw).toBeTruthy();
  });
});
