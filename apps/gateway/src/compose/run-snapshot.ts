import { type FeedService, runSnapshot } from "@psyche/proactive";
import { SCHEDULED_RUNS_ROUTE } from "@psyche/protocol";
import type { Deliverer } from "@psyche/scheduler";

const BODY_MAX = 400;

/** The run's own summary when it has one; the generic line only when it does not. */
function bodyOf(
  run: { events?: unknown[] | null },
  result: { status: string; summary: string | null },
): string {
  // An event run read mail, invitations or recordings: its text is untrusted, so the notice stays
  // generic (the Feed text is read back into chats) and the full text lives in the run itself.
  const untrusted = (run.events?.length ?? 0) > 0;
  const summary = untrusted ? "" : (result.summary?.trim() ?? "");
  if (summary !== "") {
    return summary.length > BODY_MAX ? `${summary.slice(0, BODY_MAX - 1)}…` : summary;
  }
  return result.status === "done" ? "The run finished." : "The run did not finish.";
}

/**
 * A finished automation run also leaves a Feed notice with a static outcome snapshot
 * (generative-ui-2026 §8): the status, how long it took, and a way to open the result. The
 * run's own text is the deliverable's business and never goes into the snapshot. Heartbeats and
 * the system briefing jobs have their own surfaces, and a run delivered to `none` stays quiet.
 */
export function withRunSnapshot(
  inner: Deliverer,
  feed: Pick<FeedService, "postNotice">,
): Deliverer {
  return {
    async deliver(automation, run, result) {
      const receipt = await inner.deliver(automation, run, result);
      const quiet =
        automation.kind === "heartbeat" ||
        automation.kind === "briefing" ||
        automation.delivery.none === true;
      if (quiet || (result.status !== "done" && result.status !== "failed")) return receipt;
      try {
        const ended = run.endedAt == null ? Date.now() : Date.parse(run.endedAt);
        const seconds = Math.max(0, Math.round((ended - Date.parse(run.startedAt)) / 1000));
        feed.postNotice({
          title: automation.title,
          bodyMd: bodyOf(run, result),
          reason: "automation result",
          widget: runSnapshot({
            status: result.status,
            ...(Number.isFinite(seconds) ? { seconds } : {}),
            route: run.threadId === null ? SCHEDULED_RUNS_ROUTE : `/chat/${run.threadId}`,
          }),
        });
      } catch {
        // A Feed notice is a courtesy; the delivery above already stands.
      }
      return receipt;
    },
  };
}
