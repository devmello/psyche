import {
  bindStagedApproval,
  getNight,
  getStagedAction,
  insertNight,
  insertStagedAction,
  listBoundStagedActions,
  listNights,
  listStagedActions,
  listStagedActionsByApproval,
  openDb,
  unbindStagedApproval,
  updateNight,
  updateStagedAction,
} from "@psyche/db";
import type { StagedAction } from "@psyche/protocol";
import { toolCallBindingHash } from "@psyche/protocol/binding";
import { FakeClock } from "@psyche/testing";
import { DEVICE, makeBroker } from "../../../permissions/test/helpers.ts";
import {
  type Adapter,
  type ApplyStore,
  NightShiftApply,
  sendFor,
  type ToolLookup,
} from "../../src/index.ts";
import type { CaptureOk } from "../../src/night-shift/adapters/types.ts";
import { FakeRegistry, thread } from "./adapters-registry.ts";
import { NIGHT_START } from "./rig.ts";

/**
 * A Night shift apply rig: the real broker (`makeBroker`), a real in-memory SQLite database
 * behind the repo functions the Gateway uses, and fake tools and adapters that record what ran.
 */

export const RECIPIENTS = ["ann@x.com", "bob@x.com"];

interface FakeTool {
  spec: { name: string; description: string; inputSchema: object; sideEffect: string };
  describeCall?: (p: unknown) => Record<string, unknown> | undefined;
  execute: (callId: string, params: unknown) => Promise<{ output: unknown; provenance: string }>;
}

export function applyRig() {
  const clock = new FakeClock(NIGHT_START);
  let n = 0;
  const db = openDb(":memory:", {
    now: () => new Date(clock.now()).toISOString(),
    newId: () => `id_${++n}`,
  });
  const h = makeBroker({}, clock);
  const registry = new FakeRegistry();
  registry.threads.set("t-1", thread());
  const ran: { tool: string; callId: string; params: Record<string, unknown> }[] = [];
  const stale = new Set<string>();
  const inverseStale = new Set<string>();
  const throwOn = new Set<string>();
  /** Runs right after the draft tool saved its draft: tests edit the saved draft here. */
  const afterSave: { fn?: (draftId: string) => void } = {};
  let created = 0;

  const record = (tool: string, callId: string, params: unknown) => {
    ran.push({ tool, callId, params: params as Record<string, unknown> });
    if (throwOn.has(callId)) throw new Error("the provider dropped the connection");
  };
  const sendDesc = (p: unknown) => {
    const to = ((p as { to?: string[] }).to ?? []).map((x) => x.toLowerCase()).sort();
    return {
      kind: "send_email",
      target: { kind: "recipient", value: to.join(","), display: to.join(", ") },
      bindingFields: { to, draftId: (p as { draftId?: string }).draftId ?? "" },
      grantKey: `send_email:apple:${to.join(",")}`,
    };
  };
  const tools = new Map<string, FakeTool>([
    [
      "reminders_create",
      {
        spec: { name: "reminders_create", description: "", inputSchema: {}, sideEffect: "write" },
        execute: async (callId, params) => {
          record("reminders_create", callId, params);
          return { output: { id: `rem_${++created}` }, provenance: "trusted" };
        },
      },
    ],
    [
      "reminders_delete",
      {
        spec: {
          name: "reminders_delete",
          description: "",
          inputSchema: {},
          sideEffect: "destructive",
        },
        execute: async (callId, params) => {
          record("reminders_delete", callId, params);
          return { output: { deleted: true }, provenance: "trusted" };
        },
      },
    ],
    [
      "mail_draft",
      {
        spec: { name: "mail_draft", description: "", inputSchema: {}, sideEffect: "write" },
        execute: async (callId, params) => {
          record("mail_draft", callId, params);
          const p = params as { to: string[]; subject: string; body: string; threadId: string };
          const draftId = `draft_${++created}`;
          registry.drafts.set(draftId, {
            to: [...p.to],
            cc: [],
            bcc: [],
            subject: p.subject,
            body: p.body,
            inReplyTo: p.threadId,
            attachments: [],
          });
          afterSave.fn?.(draftId);
          return {
            output: {
              draft: { draftId, subject: p.subject, to: p.to, cc: [], body: p.body },
            },
            provenance: "trusted",
          };
        },
      },
    ],
    [
      "mail_send_draft",
      {
        spec: {
          name: "mail_send_draft",
          description: "",
          inputSchema: {},
          sideEffect: "destructive",
        },
        describeCall: sendDesc,
        execute: async (callId, params) => {
          record("mail_send_draft", callId, params);
          return { output: { sent: true }, provenance: "trusted" };
        },
      },
    ],
  ]);
  const lookup: ToolLookup = { get: (name) => tools.get(name) as never };

  const fakeAdapter = (tool: string): Adapter => ({
    tools: [tool],
    capture: async () => ({ ok: false, reason: "not_in_rig" }),
    check: async (_c, cap) =>
      stale.has(cap.target) ? { fresh: false, reason: "changed" } : { fresh: true },
    preview: () => ({ kind: "reminder", title: tool, rows: [], truncated: false }),
    inverse: (_c, _cap, made) =>
      tool === "reminders_create" && made !== undefined
        ? { tool: "reminders_delete", args: { id: made.id }, destructive: true }
        : undefined,
    postState: async (_c, _cap, made) => (made === undefined ? null : { id: made.id }),
    checkInverse: async (_c, cap) =>
      inverseStale.has(cap.target) ? { fresh: false, reason: "edited" } : { fresh: true },
  });
  const adapters = new Map<string, Adapter>([
    ["reminders_create", fakeAdapter("reminders_create")],
    ["mail_draft", fakeAdapter("mail_draft")],
  ]);

  const store: ApplyStore = {
    getNight: (id) => getNight(db, id),
    updateNight: (id, p) => updateNight(db, id, p),
    getStagedAction: (id) => getStagedAction(db, id),
    listStagedActions: (id) => listStagedActions(db, id),
    updateStagedAction: (id, p) => updateStagedAction(db, id, p),
    bindApproval: (ids, approvalId, from) => bindStagedApproval(db, ids, approvalId, from),
    unbindApproval: (approvalId, status) => unbindStagedApproval(db, approvalId, status),
    listByApproval: (approvalId) => listStagedActionsByApproval(db, approvalId),
    listBound: () => listBoundStagedActions(db),
    setInverse: (id, inverse) => void updateStagedAction(db, id, { inverse }),
  };

  const newApplier = () =>
    new NightShiftApply({
      clock,
      store,
      broker: h.broker as never,
      tools: lookup,
      adapters: () => adapters,
      reads: () => registry,
      connectors: () => new Map(),
      connectorIds: () => new Set(["apple"]),
      threadId: async () => "thr_night",
      surfaces: ["desktop"],
    });
  const applier = newApplier();

  const night = insertNight(db, {
    night: "2026-11-25",
    status: "done",
    reviewStatus: "ready",
    expiresAt: new Date(NIGHT_START + 3 * 86_400_000).toISOString(),
  });

  let seq = 0;
  /** Stages an item exactly as the stager would store it, its binding hash from the tool's describeCall. */
  function stage(
    tool: "reminders_create" | "mail_draft",
    args: Record<string, unknown>,
    target: string,
    precondition: Record<string, unknown> = {},
  ): StagedAction {
    const cap: CaptureOk = { ok: true, target, precondition: precondition as never, before: {} };
    const desc = tools.get(tool)?.describeCall?.(args);
    const send = tool === "mail_draft" ? sendFor(tool, { tool, args }, cap) : undefined;
    return insertStagedAction(db, {
      nightId: night.id,
      seq: seq++,
      domain: tool === "mail_draft" ? "mail" : "reminders",
      targetKey: target,
      tool,
      kind: "connector_action",
      sideEffect: "write",
      params: args,
      paramsHash: "unused",
      bindingHash: toolCallBindingHash(tool, args, desc as never),
      summary: `${tool} ${target}`,
      precondition: cap,
      send: send ?? null,
      taint: tool === "mail_draft",
      taintSources: tool === "mail_draft" ? [{ sourceKind: "email", origin: "ann@x.com" }] : [],
    } as never);
  }

  const reminder = (title: string) =>
    stage("reminders_create", { title, listId: "L" }, `rem:${title}`);
  const draft = (body = "Tuesday works for me.") =>
    stage("mail_draft", { to: RECIPIENTS, subject: "Re: lunch", body, threadId: "t-1" }, "t-1", {
      recipients: RECIPIENTS,
    });

  /** The owner taps Approve on the card, then the children run. */
  async function approve(issued: {
    approval: { id: string };
    answerTokens: Record<string, string>;
  }) {
    clock.advance(500);
    await h.broker.answer({
      approvalId: issued.approval.id,
      answerToken: issued.answerTokens.desktop ?? "",
      decision: "approve",
      scope: "once",
      decidedBy: DEVICE,
    });
    await settle();
  }
  async function settle() {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await applier.idle();
    }
  }
  const tick = (i: StagedAction) => ({ itemId: i.id, bindingHash: i.bindingHash });
  const item = (id: string) => getStagedAction(db, id) as StagedAction;
  const review = () => getNight(db, night.id)?.reviewStatus;

  return {
    clock,
    db,
    h,
    registry,
    ran,
    stale,
    inverseStale,
    throwOn,
    afterSave,
    applier,
    newApplier,
    store,
    night,
    reminder,
    draft,
    approve,
    settle,
    tick,
    item,
    review,
    nights: () => listNights(db),
  };
}
