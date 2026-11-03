import {
  clearThread,
  deleteAgentThreadState,
  deleteSettings,
  getThread,
  type PsycheDb,
  threadActivity,
} from "@psyche/db";
import { type AuditLog, type PermissionBroker, PsycheError, type Thread } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { requireThread } from "../handlers/threads.ts";
import { usageKey } from "./context.ts";

/**
 * `threads.clear`: the owner's "Clear chat". It empties a thread in place, so the one main thread
 * (which cannot be deleted) can start over: the messages, runs and queued follow-ups go and the
 * agent's model-side state (history, compaction summary, pinned checklist, the context meter)
 * resets, while the thread row, its id, session key, title, pin, mode and model stay. Receipts
 * and audit entries are kept, and the clear itself is audited. `alsoForget` stages the same
 * memory-retraction preview as `threads.delete`. Refused with `conflict` while the thread has a
 * run, an approval or a question open, so nothing writes into the transcript being emptied.
 */

export interface ThreadClearDeps {
  db: PsycheDb;
  audit: AuditLog;
  broker: PermissionBroker;
  /** Whether a run holds the thread right now (the loop's own view). */
  isRunning(threadId: string): boolean;
}

function busyReason(deps: ThreadClearDeps, thread: Thread): string | undefined {
  const { db } = deps;
  const a = threadActivity(db, [thread.id]).get(thread.id);
  if (
    deps.isRunning(thread.id) ||
    (thread.activeWriterRunId ?? null) !== null ||
    (a !== undefined && a.running > 0)
  ) {
    return "the chat is running; clear it when the turn ends";
  }
  const open = db.sqlite
    .prepare("SELECT 1 FROM input_requests WHERE thread_id = ? AND status = 'open' LIMIT 1")
    .get(thread.id);
  if ((a !== undefined && a.awaitingInput > 0) || open !== undefined) {
    return "the chat is waiting on a question; answer it first";
  }
  if (a !== undefined && a.awaitingApproval > 0) {
    return "the chat is waiting on an approval; answer it first";
  }
  return undefined;
}

export function createThreadClear(deps: ThreadClearDeps): Record<string, HandlerDef> {
  const { db } = deps;
  return {
    "threads.clear": {
      async run(call: Call, params: { threadId: string; alsoForget?: boolean }) {
        const { ctx } = call;
        const refuse = (why: string) => {
          throw new PsycheError("conflict", why);
        };
        const first = requireThread(call, params.threadId);
        const why = busyReason(deps, first);
        if (why !== undefined) refuse(why);
        const pending = (await deps.broker.list({ status: "pending" })).filter(
          (x) => x.requestedBy.threadId === params.threadId,
        );
        if (pending.length > 0) refuse("the chat is waiting on an approval; answer it first");

        // Checked again, then done with no await in between: a send that arrived during the
        // approvals lookup keeps the transcript.
        const thread = getThread(db, params.threadId);
        if (thread === undefined) throw new PsycheError("not_found", "no such thread");
        const again = busyReason(deps, thread);
        if (again !== undefined) refuse(again);
        const cleared = db.sqlite.transaction(() => {
          const counts = clearThread(db, thread.id);
          deleteAgentThreadState(db, thread.id);
          deleteSettings(db, [usageKey(thread.id)]);
          return counts;
        })();
        ctx.bus.bumpStateVersion();

        await deps.audit
          .append({
            kind: "thread.cleared",
            actor: { type: "user", deviceId: call.identity.deviceId },
            subject: { threadId: thread.id },
            data: {
              messages: cleared.messages,
              runs: cleared.runs,
              queuedFollowUps: cleared.queued,
              alsoForget: params.alsoForget === true,
            },
          })
          .catch(() => undefined);

        ctx.bus.publish("thread.cleared", { threadId: thread.id }, thread.id);
        const after = getThread(db, thread.id);
        if (after !== undefined) {
          ctx.bus.publish("thread.updated", { thread: after }, thread.id);
        }
        if (params.alsoForget && ctx.memory !== null) {
          // "Also forget" stages a retraction preview; the owner confirms it in Memory (S07).
          await ctx.memory.forget(`thread:${thread.id}`, { dryRun: true });
        }
        return { ok: true as const };
      },
    },
  };
}
