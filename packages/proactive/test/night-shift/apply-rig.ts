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
import type { PermissionBrokerOptions } from "@psyche/permissions";
import { PsycheError, type StagedAction, type Surface, type TaintSource } from "@psyche/protocol";
import { toolCallBindingHash } from "@psyche/protocol/binding";
import { FakeClock } from "@psyche/testing";
import { DEVICE, makeBroker } from "../../../permissions/test/helpers.ts";
import {
  type Adapter,
  type ApplyStore,
  appleBodySha256,
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

export interface ApplyRigOptions {
  broker?: Partial<PermissionBrokerOptions>;
  /** The applier's card surfaces; undefined keeps W5's default (desktop, web, notification). */
  surfaces?: Surface[] | null;
}

export const FROM_MESSAGES: TaintSource[] = [{ sourceKind: "message", origin: "+15550100" }];

export function applyRig(opts: ApplyRigOptions = {}) {
  const clock = new FakeClock(NIGHT_START);
  let n = 0;
  const db = openDb(":memory:", {
    now: () => new Date(clock.now()).toISOString(),
    newId: () => `id_${++n}`,
  });
  const h = makeBroker(opts.broker ?? {}, clock);
  const registry = new FakeRegistry();
  registry.threads.set("t-1", thread());
  const ran: { tool: string; callId: string; params: Record<string, unknown> }[] = [];
  const stale = new Set<string>();
  const inverseStale = new Set<string>();
  const throwOn = new Set<string>();
  /** Mail's drafts, as the helper sees them live. */
  const mail = new Map<string, { to: string[]; cc: string[]; subject: string; body: string }>();
  /** Runs right after Mail saved the draft, before the helper reads it back: tests edit it here. */
  const afterSave: { fn?: (draftId: string) => void } = {};
  /** Runs when the send reaches the helper, before its live check. */
  const beforeSend: { fn?: () => void } = {};
  /** An error a tool call id throws instead of running (a helper timeout, a provider 5xx). */
  const throwWith = new Map<string, Error>();
  let created = 0;

  const record = (tool: string, callId: string, params: unknown) => {
    ran.push({ tool, callId, params: params as Record<string, unknown> });
    if (throwOn.has(callId)) throw new Error("the provider dropped the connection");
    const err = throwWith.get(callId);
    if (err !== undefined) throw err;
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
      // The Mac helper's `mail.draft`: Mail saves the draft (no bcc, no In-Reply-To), and the
      // helper answers what Mail holds, read back after the save (`MailDraftRecord`).
      "mail_draft",
      {
        spec: { name: "mail_draft", description: "", inputSchema: {}, sideEffect: "write" },
        execute: async (callId, params) => {
          record("mail_draft", callId, params);
          const p = params as { to: string[]; cc?: string[]; subject: string; body: string };
          const draftId = `draft_${++created}`;
          mail.set(draftId, {
            to: [...p.to],
            cc: [...(p.cc ?? [])],
            subject: p.subject,
            body: p.body,
          });
          afterSave.fn?.(draftId);
          const d = mail.get(draftId);
          if (d === undefined) throw new Error("Mail lost the draft");
          return {
            output: {
              saved: true,
              draft: { draftId, ...structuredClone(d), bodySha256: appleBodySha256(d.body) },
            },
            provenance: "trusted",
          };
        },
      },
    ],
    [
      // The helper's `mail.send_draft`: re-checks to, cc, subject and the body hash against the
      // live draft (`MailWave1.check`), and the connector maps its refusal to `unavailable`.
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
          beforeSend.fn?.();
          const p = params as {
            draftId: string;
            to: string[];
            cc?: string[];
            subject: string;
            bodySha256: string;
          };
          const d = mail.get(p.draftId);
          const same = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();
          if (
            d === undefined ||
            !same(d.to, p.to) ||
            !same(d.cc, p.cc ?? []) ||
            d.subject !== p.subject ||
            appleBodySha256(d.body) !== p.bodySha256
          ) {
            throw new PsycheError("unavailable", "Mail: the draft changed", {
              details: {
                capability: "mail.send_draft",
                helperCode: "binding_mismatch",
                reason: "draft_changed",
              },
            });
          }
          mail.delete(p.draftId);
          return { output: { sent: true }, provenance: "trusted" };
        },
      },
    ],
  ]);
  // Gmail answers only ids; Apple's reply drafts save a "Re:" subject and a quoted body.
  for (const name of ["gmail_create_draft", "mail_reply_draft"]) {
    tools.set(name, {
      spec: { name, description: "", inputSchema: {}, sideEffect: "write" },
      execute: async (callId, params) => {
        record(name, callId, params);
        const draftId = `draft_${++created}`;
        return {
          output: { draftId, messageId: `m_${draftId}`, threadId: "t-1" },
          provenance: "trusted",
        };
      },
    });
  }
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
    ["gmail_create_draft", fakeAdapter("gmail_create_draft")],
    ["mail_reply_draft", fakeAdapter("mail_reply_draft")],
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
      connectors: () => new Map(),
      connectorIds: () => new Set(["apple"]),
      threadId: async () => "thr_night",
      ...(opts.surfaces === null ? {} : { surfaces: opts.surfaces ?? ["desktop"] }),
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
    tool: "reminders_create" | "mail_draft" | "gmail_create_draft" | "mail_reply_draft",
    args: Record<string, unknown>,
    target: string,
    precondition: Record<string, unknown> = {},
    taintSources?: TaintSource[],
  ): StagedAction {
    const cap: CaptureOk = { ok: true, target, precondition: precondition as never, before: {} };
    const desc = tools.get(tool)?.describeCall?.(args);
    const mailish = tool !== "reminders_create";
    const send = mailish ? sendFor(tool, { tool, args }, cap) : undefined;
    return insertStagedAction(db, {
      nightId: night.id,
      seq: seq++,
      domain: mailish ? "mail" : "reminders",
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
      taint: mailish || taintSources !== undefined,
      taintSources: taintSources ?? (mailish ? [{ sourceKind: "email", origin: "ann@x.com" }] : []),
    } as never);
  }

  const reminder = (title: string, taintSources?: TaintSource[]) =>
    stage("reminders_create", { title, listId: "L" }, `rem:${title}`, {}, taintSources);
  const draft = (
    body = "Tuesday works for me.",
    taintSources?: TaintSource[],
    tool: "mail_draft" | "gmail_create_draft" | "mail_reply_draft" = "mail_draft",
  ) =>
    stage(
      tool as never,
      { to: RECIPIENTS, subject: "Lunch on Tuesday", body, threadId: "t-1" },
      "t-1",
      { recipients: RECIPIENTS },
      taintSources,
    );

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
    throwWith,
    mail,
    afterSave,
    beforeSend,
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
