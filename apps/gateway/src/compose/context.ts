import type { CompactionInfo, PsycheAgentLoop } from "@psyche/agent-core";
import {
  appendMessage,
  getSetting,
  getThread,
  listMessagesPage,
  type PsycheDb,
  setSetting,
} from "@psyche/db";
import {
  type AuditLog,
  type Block,
  type ContextLimits,
  type ContextUsage,
  type EffectiveContextLimits,
  type Message,
  type MethodParams,
  type MethodResult,
  type PermissionBroker,
  PsycheError,
} from "@psyche/protocol";

/**
 * Context usage per chat, owner-set limits and compaction (owner priority; features B7, C2).
 *
 * - Limits: a thread's override (`threads.setContextLimits`, stored as `context.thread.<id>`) →
 *   the settings `context.maxTokens`, `context.compactAt`, `context.keepRecentTurns` → the model
 *   (the loop caps `maxTokens` at its context window).
 * - Usage: after every turn the loop reports its last call's prompt tokens (exact when the
 *   provider says, else estimated) with a breakdown; it is kept as `context.usage.<id>` and
 *   published as `thread.context.updated`.
 * - Compaction: each one (automatic or `threads.compact`) adds a `system` message with a
 *   `compaction` block where it happened, naming the transcript range it replaced (those
 *   messages stay: the summary is what the model reads instead), and an audit entry.
 *   `threads.compact` is refused while the thread runs or waits on an approval.
 */

export const CONTEXT_SETTINGS = {
  maxTokens: "context.maxTokens",
  compactAt: "context.compactAt",
  keepRecentTurns: "context.keepRecentTurns",
} as const;
const threadKey = (threadId: string) => `context.thread.${threadId}`;
const usageKey = (threadId: string) => `context.usage.${threadId}`;

export interface ContextDeps {
  db: PsycheDb;
  audit: AuditLog;
  broker: PermissionBroker;
  publish(
    event: "thread.context.updated" | "chat.message",
    payload: unknown,
    threadId: string,
  ): void;
  /** Whether a run holds the thread's transcript right now. */
  isRunning(threadId: string): boolean;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function settingsLimits(db: PsycheDb): ContextLimits {
  const maxTokens = num(getSetting(db, CONTEXT_SETTINGS.maxTokens)?.value);
  const compactAt = num(getSetting(db, CONTEXT_SETTINGS.compactAt)?.value);
  const keep = num(getSetting(db, CONTEXT_SETTINGS.keepRecentTurns)?.value);
  return {
    ...(maxTokens === undefined ? {} : { maxTokens: Math.max(1_000, Math.floor(maxTokens)) }),
    ...(compactAt === undefined ? {} : { compactAt: Math.min(0.95, Math.max(0.2, compactAt)) }),
    ...(keep === undefined ? {} : { keepRecentTurns: Math.min(20, Math.max(1, Math.floor(keep))) }),
  };
}

function threadLimits(db: PsycheDb, threadId: string): ContextLimits {
  const v = getSetting(db, threadKey(threadId))?.value;
  return typeof v === "object" && v !== null ? (v as ContextLimits) : {};
}

export function createContext(deps: ContextDeps) {
  const { db } = deps;

  /** What the loop asks for every turn: the thread's override over the settings. */
  const contextLimits = (threadId: string): ContextLimits => ({
    ...settingsLimits(db),
    ...threadLimits(db, threadId),
  });

  const onContextUsage = (usage: ContextUsage) => {
    const own = threadLimits(db, usage.threadId);
    const fixed: ContextUsage = {
      ...usage,
      limits: {
        ...usage.limits,
        maxTokensFrom:
          own.maxTokens !== undefined
            ? "thread"
            : usage.limits.maxTokensFrom === "model"
              ? "model"
              : "settings",
      },
    };
    setSetting(db, usageKey(usage.threadId), fixed);
    deps.publish("thread.context.updated", { usage: fixed }, usage.threadId);
  };

  const onCompaction = async (c: CompactionInfo) => {
    const thread = getThread(db, c.threadId);
    if (thread === undefined) return;
    // The transcript range it replaced: after the previous compaction, up to the kept turns.
    const { messages } = listMessagesPage(db, c.threadId, { limit: 1_000 });
    const lastCompaction = messages.findLastIndex((m) =>
      m.blocks.some((b) => b.type === "compaction"),
    );
    const users = messages
      .map((m, i) => ({ m, i }))
      .filter(({ m, i }) => m.role === "user" && i > lastCompaction);
    const firstKept = users.at(-c.keptTurns)?.i ?? messages.length;
    const range = messages.slice(lastCompaction + 1, firstKept);
    const block: Block = {
      type: "compaction",
      compactionId: c.compactionId,
      trigger: c.trigger,
      summary: c.summary,
      replaced: {
        turns: c.replacedTurns,
        fromMessageId: range[0]?.id ?? null,
        toMessageId: range.at(-1)?.id ?? null,
      },
      tokensBefore: c.tokensBefore,
      tokensAfter: c.tokensAfter,
    };
    let message: Message | undefined;
    try {
      message = appendMessage(
        db,
        { threadId: c.threadId, role: "system", blocks: [block], provenance: "agent", runId: null },
        { expectedWriterRunId: c.trigger === "auto" ? c.runId : null },
      );
    } catch {
      // The transcript moved on (another writer): the summary still applies to the model.
    }
    if (message !== undefined) deps.publish("chat.message", { message }, c.threadId);
    await deps.audit
      .append({
        kind: "thread.compacted",
        actor: c.trigger === "auto" ? { type: "agent", runId: c.runId } : { type: "user" },
        subject: { threadId: c.threadId },
        data: {
          compactionId: c.compactionId,
          trigger: c.trigger,
          replacedTurns: c.replacedTurns,
          tokensBefore: c.tokensBefore,
          tokensAfter: c.tokensAfter,
          fromMessageId: block.replaced.fromMessageId,
          toMessageId: block.replaced.toMessageId,
          ...(message === undefined ? {} : { messageId: message.id }),
        },
      })
      .catch(() => undefined);
    lastMessage.set(c.compactionId, message?.id ?? null);
  };
  const lastMessage = new Map<string, string | null>();

  const handlers = (
    loop: () => PsycheAgentLoop,
    window: (threadId: string) => Promise<EffectiveContextLimits>,
  ) => ({
    "threads.contextUsage": async (
      p: MethodParams<"threads.contextUsage">,
    ): Promise<MethodResult<"threads.contextUsage">> => {
      if (getThread(db, p.threadId) === undefined)
        throw new PsycheError("not_found", "no such thread");
      const usage = getSetting(db, usageKey(p.threadId))?.value as ContextUsage | undefined;
      return {
        usage: usage ?? null,
        limits: await window(p.threadId),
        threadLimits: threadLimits(db, p.threadId),
      };
    },
    "threads.setContextLimits": async (
      p: MethodParams<"threads.setContextLimits">,
    ): Promise<MethodResult<"threads.setContextLimits">> => {
      if (getThread(db, p.threadId) === undefined)
        throw new PsycheError("not_found", "no such thread");
      const limits = await window(p.threadId);
      if (p.limits?.maxTokens !== undefined && p.limits.maxTokens > limits.contextWindow) {
        throw new PsycheError(
          "invalid_params",
          `maxTokens ${p.limits.maxTokens} is over the model's ${limits.contextWindow}-token window`,
        );
      }
      setSetting(db, threadKey(p.threadId), p.limits ?? {});
      return { limits: await window(p.threadId), threadLimits: threadLimits(db, p.threadId) };
    },
    "threads.compact": async (
      p: MethodParams<"threads.compact">,
    ): Promise<MethodResult<"threads.compact">> => {
      if (getThread(db, p.threadId) === undefined)
        throw new PsycheError("not_found", "no such thread");
      if (deps.isRunning(p.threadId)) {
        throw new PsycheError("conflict", "the thread is running; compact it when the turn ends");
      }
      const pending = (await deps.broker.list({ status: "pending" })).filter(
        (a) => a.requestedBy.threadId === p.threadId,
      );
      if (pending.length > 0) {
        throw new PsycheError("conflict", "the thread is waiting on an approval; answer it first");
      }
      const info = await loop().compactThread(p.threadId);
      if (info === undefined) return { compaction: null };
      return {
        compaction: {
          compactionId: info.compactionId,
          messageId: lastMessage.get(info.compactionId) ?? info.compactionId,
          tokensBefore: info.tokensBefore,
          tokensAfter: info.tokensAfter,
          replacedTurns: info.replacedTurns,
        },
      };
    },
  });

  return { contextLimits, onContextUsage, onCompaction, handlers };
}
