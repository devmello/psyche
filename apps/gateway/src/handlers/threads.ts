import {
  copyMessagesForFork,
  createThread,
  deleteAgentThreadState,
  deleteThread,
  findThreadBySessionKey,
  getMessage,
  getThread,
  listEmptyUserChats,
  listMessagesPage,
  listThreadsPage,
  threadActivity,
  updateThread,
} from "@psyche/db";
import {
  type ModelRef,
  type PermissionMode,
  PsycheError,
  type Thread,
  type ThreadKind,
  type ThreadPreview,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";

/** The owner's one persistent main thread (feature E1). */
export const MAIN_SESSION_KEY = "owner:main";
/** Incognito threads expire after 24 h (data model §12). */
export const INCOGNITO_TTL_MS = 24 * 3_600_000;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

const PREVIEW_MAX = 160;
/** Messages scanned from the end for the last line (tool and system messages are skipped). */
const PREVIEW_SCAN = 20;

/** Markdown reduced to one line of plain text for the sidebar. */
export function previewText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The newest user or agent text of a thread (UI design §2.2: the row's last line). */
export function threadPreview(call: Call, threadId: string): ThreadPreview | undefined {
  const { messages } = listMessagesPage(call.ctx.db, threadId, { limit: PREVIEW_SCAN });
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m === undefined || (m.role !== "user" && m.role !== "agent")) continue;
    const text = previewText(m.blocks.map((b) => (b.type === "text" ? b.md : "")).join(" "));
    if (text === "") continue;
    return {
      role: m.role,
      text: text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text,
      at: m.createdAt,
    };
  }
  return undefined;
}

function withPreview<T extends { thread: Thread }>(
  call: Call,
  entry: T,
): T & {
  lastMessage?: ThreadPreview;
} {
  const lastMessage = threadPreview(call, entry.thread.id);
  return lastMessage === undefined ? entry : { ...entry, lastMessage };
}

export function requireThread(call: Call, threadId: string): Thread {
  const thread = getThread(call.ctx.db, threadId);
  if (!thread) throw new PsycheError("not_found", `thread ${threadId} not found`);
  return thread;
}

/** Offset cursors: opaque to clients, `o<offset>` here. */
export function encodeOffset(offset: number): string {
  return `o${offset}`;
}

export function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const n = /^o(\d{1,9})$/.exec(cursor)?.[1];
  if (n === undefined) throw new PsycheError("invalid_params", "bad cursor");
  return Number(n);
}

function emitThread(call: Call, thread: Thread): void {
  call.ctx.bus.bumpStateVersion();
  call.emit("thread.updated", { thread }, thread.id);
}

function patch(
  call: Call,
  threadId: string,
  p: Parameters<typeof updateThread>[2],
): { thread: Thread } {
  requireThread(call, threadId);
  const thread = updateThread(call.ctx.db, threadId, p) as Thread;
  emitThread(call, thread);
  return { thread };
}

/**
 * Removes a thread for good: running work stops first (no queued follow-up starts), so nothing
 * writes into or acts for a deleted transcript; then the rows go (messages, runs and queued
 * follow-ups cascade; the agent's per-thread state is deleted with it) and `thread.deleted` tells
 * every connected window.
 */
export async function removeThread(call: Call, threadId: string): Promise<void> {
  const { ctx } = call;
  await ctx.sessions.closeThread(threadId, () => {
    deleteThread(ctx.db, threadId);
    deleteAgentThreadState(ctx.db, threadId);
    ctx.bus.bumpStateVersion();
  });
  ctx.bus.publish("thread.deleted", { threadId }, threadId);
}

export const threadsHandlers: Record<string, HandlerDef> = {
  "threads.create": {
    transactional: true,
    run(
      call: Call,
      params: {
        kind?: ThreadKind;
        title?: string;
        permissionMode?: PermissionMode;
        modelRef?: ModelRef;
        parentThreadId?: string;
      },
    ) {
      const { db } = call.ctx;
      const kind = params.kind ?? "main";
      if (kind !== "main" && kind !== "side" && kind !== "incognito") {
        throw new PsycheError(
          "invalid_params",
          `${kind} threads are created by their owning subsystem`,
        );
      }
      if (params.parentThreadId !== undefined) requireThread(call, params.parentThreadId);
      // Model choice is a security control (security §7.2): `auto` only with an allowlisted model.
      if (params.permissionMode === "auto") {
        const ref = params.modelRef;
        if (ref === undefined || call.ctx.threadModels?.allowsAutoMode(ref) !== true) {
          throw new PsycheError(
            "forbidden",
            "Auto mode needs a model on the auto-mode allowlist (modelRef).",
          );
        }
      }
      if (kind === "main") {
        const existing = findThreadBySessionKey(db, MAIN_SESSION_KEY, "main");
        if (existing) return { thread: existing };
      }
      const id = db.newId();
      const thread = createThread(db, {
        id,
        kind,
        sessionKey: kind === "main" ? MAIN_SESSION_KEY : `owner:${kind}:${id}`,
        ...(params.title === undefined ? {} : { title: params.title }),
        ...(params.permissionMode === undefined ? {} : { permissionMode: params.permissionMode }),
        modelRef: params.modelRef ?? null,
        parentThreadId: params.parentThreadId ?? null,
        expiresAt:
          kind === "incognito"
            ? new Date(call.ctx.now().getTime() + INCOGNITO_TTL_MS).toISOString()
            : null,
      });
      emitThread(call, thread);
      const pin = call.ctx.threadModels?.setThreadModel;
      const ref = params.modelRef;
      if (pin !== undefined && ref !== undefined) {
        // The router learns the pin once the row exists; a refusal is logged, not fatal.
        call.afterCommit(() => {
          pin(thread.id, ref).catch((err: unknown) =>
            call.ctx.log.log("warn", "thread model refused by the router", {
              threadId: thread.id,
              code: PsycheError.from(err).code,
            }),
          );
        });
      }
      return { thread };
    },
  },
  "threads.newChat": {
    transactional: true,
    run(call: Call, params: { kind: "side" | "incognito"; preferThreadId?: string }) {
      const { db } = call.ctx;
      const empty = listEmptyUserChats(db, { kind: params.kind });
      const reuse = empty.find((t) => t.id === params.preferThreadId) ?? empty[0];
      if (reuse) {
        // Opening it again restarts its clock for the empty-chat sweep.
        const thread = updateThread(db, reuse.id, {}) as Thread;
        return { thread, reused: true };
      }
      const id = db.newId();
      const thread = createThread(db, {
        id,
        kind: params.kind,
        sessionKey: `owner:${params.kind}:${id}`,
        userCreated: true,
        expiresAt:
          params.kind === "incognito"
            ? new Date(call.ctx.now().getTime() + INCOGNITO_TTL_MS).toISOString()
            : null,
      });
      emitThread(call, thread);
      return { thread, reused: false };
    },
  },
  "threads.discardEmpty": {
    async run(call: Call, params: { threadId: string }) {
      // Eligibility is the Gateway's call, not the window's: a message, a run, a queued
      // follow-up, a task or a pin that arrived since the window looked keeps the thread.
      if (listEmptyUserChats(call.ctx.db, { threadId: params.threadId }).length === 0)
        return { deleted: false };
      await removeThread(call, params.threadId);
      return { deleted: true };
    },
  },
  "threads.list": {
    run(
      call: Call,
      params: {
        kind?: ThreadKind;
        includeArchived?: boolean;
        pinnedOnly?: boolean;
        query?: string;
        cursor?: string;
        limit?: number;
      },
    ) {
      const offset = decodeOffset(params.cursor);
      const limit = Math.min(params.limit ?? DEFAULT_PAGE, MAX_PAGE);
      const page = listThreadsPage(call.ctx.db, {
        offset,
        limit,
        ...(params.kind === undefined ? {} : { kind: params.kind }),
        ...(params.includeArchived === undefined
          ? {}
          : { includeArchived: params.includeArchived }),
        ...(params.pinnedOnly === undefined ? {} : { pinnedOnly: params.pinnedOnly }),
        hideEmptyChats: true,
        ...(params.query === undefined ? {} : { query: params.query }),
      });
      const activity = threadActivity(
        call.ctx.db,
        page.threads.map((t) => t.id),
      );
      return {
        threads: page.threads.map((thread) =>
          withPreview(call, {
            thread,
            activity: activity.get(thread.id) ?? {
              running: 0,
              awaitingInput: 0,
              awaitingApproval: 0,
            },
          }),
        ),
        nextCursor: page.hasMore ? encodeOffset(offset + page.threads.length) : null,
      };
    },
  },
  "threads.get": {
    run(call: Call, params: { threadId: string }) {
      const thread = requireThread(call, params.threadId);
      const activity = threadActivity(call.ctx.db, [thread.id]).get(thread.id);
      return withPreview(call, { thread, activity });
    },
  },
  "threads.rename": {
    transactional: true,
    run: (call: Call, params: { threadId: string; title: string }) =>
      patch(call, params.threadId, { title: params.title, titleSource: "user" }),
  },
  "threads.archive": {
    transactional: true,
    run: (call: Call, params: { threadId: string }) =>
      patch(call, params.threadId, { archivedAt: call.ctx.now().toISOString() }),
  },
  "threads.restore": {
    transactional: true,
    run: (call: Call, params: { threadId: string }) =>
      patch(call, params.threadId, { archivedAt: null }),
  },
  "threads.pin": {
    transactional: true,
    run: (call: Call, params: { threadId: string; pinned: boolean }) =>
      patch(call, params.threadId, { pinned: params.pinned }),
  },
  "threads.delete": {
    async run(call: Call, params: { threadId: string; alsoForget?: boolean }) {
      const { ctx } = call;
      requireThread(call, params.threadId);
      await removeThread(call, params.threadId);
      if (params.alsoForget && ctx.memory) {
        // "Also forget" stages a retraction preview; the owner confirms it in Memory (S07).
        await ctx.memory.forget(`thread:${params.threadId}`, { dryRun: true });
      }
      return { ok: true as const };
    },
  },
  "threads.fork": {
    transactional: true,
    run(call: Call, params: { threadId: string; messageId: string; title?: string }) {
      const { db } = call.ctx;
      const source = requireThread(call, params.threadId);
      const message = getMessage(db, params.messageId);
      if (!message || message.threadId !== source.id) {
        throw new PsycheError(
          "not_found",
          `message ${params.messageId} is not in thread ${source.id}`,
        );
      }
      const id = db.newId();
      const thread = createThread(db, {
        id,
        kind: "side",
        sessionKey: `owner:side:${id}`,
        title: params.title ?? (source.title ? `Fork of ${source.title}` : "Fork"),
        titleSource: params.title === undefined ? "auto" : "user",
        parentThreadId: source.id,
        forkedFromMessageId: message.id,
        permissionMode: source.permissionMode,
        modelRef: source.modelRef ?? null,
      });
      // Tool results and provider-native turns are copied verbatim (feature E2).
      copyMessagesForFork(db, source.id, thread.id, message.seq);
      const forked = getThread(db, thread.id) as Thread;
      emitThread(call, forked);
      return { thread: forked };
    },
  },
};
