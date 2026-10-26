import { findThreadBySessionKey } from "@psyche/db";
import type { ApprovalRequest, InputRequest, Run, ToolCall } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import {
  AsyncQueue,
  narrationLabel,
  type VoiceTurnEvent,
  type VoiceTurnInput,
  type VoiceTurnPort,
} from "@psyche/speech";
import { MAIN_SESSION_KEY } from "../handlers/threads.ts";
import type { Gateway } from "../server.ts";
import type { TxHooks } from "../session/controller.ts";

/**
 * The voice conversation's turns over the Gateway's chat path (docs/voice/voice-mode-2026.md
 * §4.2). The owner's words go to the session controller as a `via: "voice"` owner message, with
 * the turn's voice options. That is the same path as `chat.send`, so tools, memory, approvals,
 * taint and receipts work exactly as in chat. A turn spoken while a run is still active
 * interrupts it: a queued follow-up would never be spoken.
 *
 * The run's events come back from the bus, filtered to this run:
 * - `chat.delta` becomes text;
 * - `tool_call.updated` becomes a step, with a fixed narration label from the tool's name;
 * - `approval.created`, `question.created` and the `awaiting_*` statuses become `waiting`;
 * - `running` after a wait becomes `resumed`;
 * - a finished run becomes `done`.
 */

const FINISHED = new Set(["done", "failed", "cancelled"]);

export function chatVoiceTurns(gateway: () => Gateway | null): VoiceTurnPort {
  return {
    send(input: VoiceTurnInput): AsyncIterable<VoiceTurnEvent> {
      const gw = gateway();
      if (gw === null) throw new PsycheError("unavailable", "gateway not started");
      const { db, sessions, bus } = gw.context;
      const threadId =
        input.threadId ?? findThreadBySessionKey(db, MAIN_SESSION_KEY, "main")?.id ?? null;
      if (threadId === null) throw new PsycheError("not_found", "there is no main thread yet");

      const out = new AsyncQueue<VoiceTurnEvent>();
      let runId: string | null = null;
      let waiting = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (status: "done" | "failed" | "cancelled") => {
        out.push({ type: "done", status });
        unsubscribe?.();
        out.end();
      };
      const onFrame = (frame: string) => {
        if (runId === null) return;
        let f: { event?: string; payload?: Record<string, unknown> };
        try {
          f = JSON.parse(frame) as typeof f;
        } catch {
          return;
        }
        const p = f.payload ?? {};
        switch (f.event) {
          case "chat.delta":
            if (p.runId === runId && typeof p.delta === "string") {
              out.push({ type: "delta", text: p.delta });
            }
            return;
          case "tool_call.updated": {
            const call = p.toolCall as ToolCall | undefined;
            if (call?.runId !== runId) return;
            out.push({
              type: "step",
              toolCallId: call.id,
              label: narrationLabel(call.tool),
              status: call.status,
            });
            return;
          }
          case "approval.created": {
            const a = p.approval as ApprovalRequest | undefined;
            if (a?.requestedBy.runId !== runId) return;
            waiting = true;
            out.push({
              type: "waiting",
              reason: "approval",
              approvalId: a.id,
              approval: {
                id: a.id,
                summary: a.summary,
                ...(a.sideEffect === undefined ? {} : { sideEffect: a.sideEffect }),
                deviceOnly: a.deviceOnly,
                requiresAuthentication: a.requiresAuthentication,
                taint: a.taint,
                scopesOffered: a.scopesOffered,
              },
            });
            return;
          }
          case "question.created": {
            const q = p.inputRequest as (InputRequest & { runId?: string }) | undefined;
            if (q === undefined || q.threadId !== threadId) return;
            waiting = true;
            out.push({ type: "waiting", reason: "question" });
            return;
          }
          case "run.updated": {
            const run = p.run as Run | undefined;
            if (run?.id !== runId) return;
            if (run.status === "awaiting_approval" || run.status === "awaiting_input") {
              if (!waiting) {
                waiting = true;
                out.push({
                  type: "waiting",
                  reason: run.status === "awaiting_approval" ? "approval" : "question",
                });
              }
            } else if (run.status === "running" && waiting) {
              waiting = false;
              out.push({ type: "resumed" });
            } else if (FINISHED.has(run.status)) {
              finish(run.status as "done" | "failed" | "cancelled");
            }
            return;
          }
        }
      };
      unsubscribe = bus.subscribe(["operator.read"], onFrame);
      input.signal.addEventListener(
        "abort",
        () => {
          unsubscribe?.();
          out.end();
        },
        { once: true },
      );

      const events: Array<() => void> = [];
      const after: Array<() => void> = [];
      const hooks: TxHooks = {
        emit: (event, payload, tid) => events.push(() => bus.publish(event, payload, tid)),
        afterCommit: (fn) => after.push(fn),
      };
      let result: { runId?: string | null; queued: boolean };
      try {
        result = db.sqlite.transaction(() =>
          sessions.send(
            {
              threadId,
              content: input.text,
              deviceId: input.deviceId,
              voice: input.voice,
              ...(sessions.activeRunId(threadId) === null ? {} : { mode: "interrupt" as const }),
            },
            hooks,
          ),
        )();
      } catch (err) {
        unsubscribe();
        throw err;
      }
      runId = result.runId ?? null;
      for (const fn of events) fn();
      for (const fn of after) fn();
      if (runId === null) finish("done");
      return out;
    },
  };
}
