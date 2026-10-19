import { createHash } from "node:crypto";
import type { Automation, AutomationRun, Notifier, PermissionBroker } from "@psyche/protocol";
import type { Deliverer, RunResult } from "./types.ts";

export type WebhookFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ status: number }>;

export interface DelivererOptions {
  notifier?: Notifier;
  /** Posts into a thread other than the run's own (S01's transcript writer). */
  postToThread?: (threadId: string, text: string, run: AutomationRun) => Promise<void>;
  /** Sends to a channel (S10). Without it, channel deliveries become inbox briefings. */
  sendToChannel?: (channelId: string, text: string, run: AutomationRun) => Promise<void>;
  /** Webhook delivery is a side effect: it needs the broker (and records a receipt). */
  broker?: PermissionBroker;
  webhookFetch?: WebhookFetch;
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
      if (
        d.thread === undefined &&
        d.channel === undefined &&
        d.webhook === undefined &&
        automation.kind === "briefing"
      ) {
        const n = await options.notifier?.notify({
          kind: "briefing",
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
  const origin = new URL(url).origin;
  const body = JSON.stringify({
    automationId: automation.id,
    runId: run.id,
    title: automation.title,
    scheduledFor: run.scheduledFor,
    text,
  });
  const paramsHash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const decision = await broker.decide(
    {
      tool: "automation.webhook",
      sideEffect: "write",
      targetKind: "origin",
      target: { kind: "origin", value: origin },
      params: { url, automationId: automation.id, runId: run.id },
      paramsHash,
    },
    {
      threadId: run.threadId ?? "",
      runId: run.id,
      permissionMode: "balanced",
      taint: false,
      unattended: true,
    },
  );
  if (decision.decision !== "allow") {
    await options.notifier?.notify({
      kind: "system",
      title: `${automation.title}: webhook not sent`,
      body: `Delivery to ${origin} was ${decision.decision === "deny" ? "denied" : "held for approval"} (${decision.rule}).`,
      route: `/upcoming/${automation.id}`,
    });
    return;
  }
  let outcome: "ok" | "failed" = "failed";
  let status = 0;
  try {
    status = (
      await webhookFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
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
    });
  }
}
