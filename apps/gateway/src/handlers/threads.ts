import {
  copyMessagesForFork,
  createThread,
  deleteThread,
  findThreadBySessionKey,
  getMessage,
  getThread,
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
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";

/** The owner's one persistent main thread (feature E1). */
export const MAIN_SESSION_KEY = "owner:main";
/** Incognito threads expire after 24 h (data model §12). */
export const INCOGNITO_TTL_MS = 24 * 3_600_000;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

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
      return { thread };
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
        ...(params.query === undefined ? {} : { query: params.query }),
      });
      const activity = threadActivity(
        call.ctx.db,
        page.threads.map((t) => t.id),
      );
      return {
        threads: page.threads.map((thread) => ({
          thread,
          activity: activity.get(thread.id) ?? {
            running: 0,
            awaitingInput: 0,
            awaitingApproval: 0,
          },
        })),
        nextCursor: page.hasMore ? encodeOffset(offset + page.threads.length) : null,
      };
    },
  },
  "threads.get": {
    run(call: Call, params: { threadId: string }) {
      const thread = requireThread(call, params.threadId);
      const activity = threadActivity(call.ctx.db, [thread.id]).get(thread.id);
      return { thread, activity };
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
      // Running work stops first (no queued follow-up starts), so nothing writes into or acts
      // for a deleted transcript.
      await ctx.sessions.closeThread(params.threadId, () => {
        deleteThread(ctx.db, params.threadId);
        ctx.bus.bumpStateVersion();
      });
      ctx.bus.publish("thread.deleted", { threadId: params.threadId }, params.threadId);
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
