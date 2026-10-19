import { createHash } from "node:crypto";
import type {
  Automation,
  AutomationRun,
  IssuedApproval,
  Notifier,
  PermissionBroker,
} from "@psyche/protocol";
import type { Deliverer, RunResult } from "./types.ts";

/**
 * POSTs a webhook. Must apply the connectors' SSRF policy (resolved addresses, not only the host
 * name) and must not follow redirects (`redirect: "error"`).
 */
export type WebhookFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    redirect: "error";
    signal?: AbortSignal;
  },
) => Promise<{ status: number }>;

/** Loopback, private, link-local and internal host names or literals (checked before DNS). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (h.includes(":")) {
    return (
      h === "::" ||
      h === "::1" ||
      h.startsWith("fc") ||
      h.startsWith("fd") ||
      h.startsWith("fe80") ||
      h.startsWith("::ffff:")
    );
  }
  return false;
}

export interface DelivererOptions {
  notifier?: Notifier;
  /** Posts into a thread other than the run's own (S01's transcript writer). */
  postToThread?: (threadId: string, text: string, run: AutomationRun) => Promise<void>;
  /** Sends to a channel (S10). Without it, channel deliveries become inbox briefings. */
  sendToChannel?: (channelId: string, text: string, run: AutomationRun) => Promise<void>;
  /** Webhook delivery is a side effect: it needs the broker (and records a receipt). */
  broker?: PermissionBroker;
  webhookFetch?: WebhookFetch;
  /** Errors from deliveries that finish later (a webhook approved after the run). */
  onError?: (error: unknown) => void;
  /** A webhook send was queued for approval (S01 surfaces the card; tests answer it). */
  onApprovalQueued?: (issued: IssuedApproval) => void;
}

/** The notification kind for a deliverable with no explicit target. */
function fallbackKind(kind: Automation["kind"]): "reminder" | "briefing" | "task_done" {
  return kind === "reminder" ? "reminder" : kind === "briefing" ? "briefing" : "task_done";
}

/**
 * Delivers a finished run's deliverable (architecture §4.11): `none` → nothing; `thread` → that
 * thread (the run's own session thread already has it); `channel` → the channel adapter or an
 * inbox briefing; `webhook` → POST after a `PermissionBroker` decision, with a receipt. The
 * heartbeat surfaces at most one notification per run.
 */
export function createDeliverer(options: DelivererOptions): Deliverer {
  return {
    async deliver(automation: Automation, run: AutomationRun, result: RunResult) {
      const text = result.summary ?? "";
      if (text.trim() === "") return {};
      const route =
        run.threadId === null ? `/upcoming/${automation.id}` : `/threads/${run.threadId}`;
      if (automation.kind === "heartbeat") {
        const n = await options.notifier?.notify({
          kind: "proactive",
          title: "Check-in",
          body: text,
          route,
          dedupeKey: `heartbeat:${run.id}`,
        });
        return n === undefined ? {} : { notificationId: n.id };
      }
      const d = automation.delivery;
      if (d.none === true) return {};
      let notificationId: string | undefined;
      if (d.thread !== undefined && d.thread !== run.threadId) {
        await options.postToThread?.(d.thread, text, run);
      }
      if (d.channel !== undefined) {
        if (options.sendToChannel !== undefined) {
          await options.sendToChannel(d.channel, text, run);
        } else {
          const n = await options.notifier?.notify({
            kind: "briefing",
            title: automation.title,
            body: text,
            route,
            dedupeKey: `automation:${automation.id}:${run.id}`,
          });
          notificationId = n?.id;
        }
      }
      if (d.webhook !== undefined) await deliverWebhook(options, automation, run, d.webhook, text);
      if (d.thread === undefined && d.channel === undefined && d.webhook === undefined) {
        // No target configured: the owner still sees the result in the inbox.
        const n = await options.notifier?.notify({
          kind: fallbackKind(automation.kind),
          title: automation.title,
          body: text,
          route,
          dedupeKey: `automation:${automation.id}:${run.id}`,
        });
        notificationId = n?.id;
      }
      return notificationId === undefined ? {} : { notificationId };
    },
  };
}

async function deliverWebhook(
  options: DelivererOptions,
  automation: Automation,
  run: AutomationRun,
  url: string,
  text: string,
): Promise<void> {
  const { broker, webhookFetch } = options;
  if (broker === undefined || webhookFetch === undefined) return;
  const target = new URL(url);
  const origin = target.origin;
  if (target.protocol !== "https:" || isPrivateHost(target.hostname)) {
    await notifyHeld(options, automation, origin, "refused (not a public https origin)");
    return;
  }
  const body = JSON.stringify({
    automationId: automation.id,
    runId: run.id,
    title: automation.title,
    scheduledFor: run.scheduledFor,
    text,
  });
  const paramsHash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  // Sending agent output to a third party is `destructive` (architecture §4.3). The output of an
  // unattended run may carry untrusted content, so the call is treated as tainted.
  const decision = await broker.decide(
    {
      tool: "automation.webhook",
      sideEffect: "destructive",
      targetKind: "origin",
      target: { kind: "origin", value: origin },
      params: { url, automationId: automation.id, runId: run.id },
      paramsHash,
      kind: "connector_action",
      bindingHash: paramsHash,
      grantKey: `automation.webhook|${origin}`,
    },
    {
      threadId: run.threadId ?? "",
      runId: run.id,
      ...(run.taskId == null ? {} : { taskId: run.taskId }),
      permissionMode: "balanced",
      taint: true,
      unattended: true,
    },
  );
  const post = async (approvalId: string | null) => {
    let outcome: "ok" | "failed" = "failed";
    let status = 0;
    try {
      status = (
        await webhookFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        })
      ).status;
      outcome = status >= 200 && status < 300 ? "ok" : "failed";
    } finally {
      await broker.recordReceipt({
        kind: "webhook.post",
        outcome,
        summary: `POST ${origin} (${status || "no response"})`,
        externalRefs: { origin, status },
        payload: { automationId: automation.id, runId: run.id, paramsHash },
        approvalId,
      });
    }
  };
  if (decision.decision === "allow") {
    await post(null);
    return;
  }
  if (decision.decision === "deny") {
    await notifyHeld(options, automation, origin, `denied (${decision.rule})`);
    return;
  }
  // `ask`: unattended runs never wait inline. The approval goes to the queue with the exact
  // payload bound; the POST happens if and when the owner approves it (architecture §4.3).
  const issued = await broker.requestApproval({
    kind: decision.approvalKind ?? "connector_action",
    summary: `Send "${automation.title}" to ${origin}`,
    details: {
      url,
      origin,
      automationId: automation.id,
      runId: run.id,
      preview: text.slice(0, 500),
    },
    bindingHash: decision.bindingHash ?? paramsHash,
    grantKey: decision.grantKey ?? `automation.webhook|${origin}`,
    requestedBy: { runId: run.id, taskId: run.taskId ?? null, threadId: run.threadId ?? null },
    sideEffect: "destructive",
    targetKind: "origin",
    target: { kind: "origin", value: origin },
    surfaces: ["desktop", "notification"],
    taint: true,
  });
  options.onApprovalQueued?.(issued);
  const id = issued.approval.id;
  void broker
    .awaitDecision(id)
    .then(async (a) => {
      if (a.status !== "approved") return;
      const v = await broker.verifyBinding(id, issued.approval.bindingHash);
      if (v.ok) await post(id);
    })
    .catch((e: unknown) => options.onError?.(e));
}

async function notifyHeld(
  options: DelivererOptions,
  automation: Automation,
  origin: string,
  why: string,
): Promise<void> {
  await options.notifier?.notify({
    kind: "system",
    title: `${automation.title}: webhook not sent`,
    body: `Delivery to ${origin} was ${why}.`,
    route: `/upcoming/${automation.id}`,
  });
}
