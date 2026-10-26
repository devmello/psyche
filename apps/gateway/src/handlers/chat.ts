import { listAllMessages, listMessagesPage, listQueue } from "@psyche/db";
import {
  type Block,
  type ChatScreenRef,
  type Message,
  PsycheError,
  type QueueMode,
  type Thread,
} from "@psyche/protocol";
import type { Call, HandlerDef, ResolvedScreen } from "../context.ts";
import { requireThread } from "./threads.ts";

const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

function decodeSeqCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const n = /^s(\d{1,12})$/.exec(cursor)?.[1];
  if (n === undefined) throw new PsycheError("invalid_params", "bad cursor");
  return Number(n);
}

function send(
  call: Call,
  params: {
    threadId: string;
    content: string;
    attachments?: string[];
    replyToMessageId?: string;
    redo?: { messageId: string; instruction?: string; withoutLessons?: boolean };
    screen?: ChatScreenRef;
  },
  mode: QueueMode | undefined,
) {
  requireThread(call, params.threadId);
  // Ask about my screen: the capture's context, frame and taint (docs/design/screen-ask-2026.md).
  let screen: ResolvedScreen | undefined;
  if (params.screen !== undefined) {
    const resolve = call.ctx.chatScreen.resolve;
    if (resolve === null)
      throw new PsycheError("unavailable", "Ask about my screen is not available here");
    screen = resolve(params.screen, {
      deviceId: call.identity.deviceId,
      threadId: params.threadId,
    });
  }
  const redo = params.redo;
  if (redo !== undefined) {
    // Parts (the teaching loop) hear about a redo once the send commits.
    call.afterCommit(() => {
      for (const listener of call.ctx.chatRedo) {
        try {
          listener({
            threadId: params.threadId,
            messageId: redo.messageId,
            ...(redo.instruction === undefined ? {} : { instruction: redo.instruction }),
            ...(redo.withoutLessons === undefined ? {} : { withoutLessons: redo.withoutLessons }),
            deviceId: call.identity.deviceId,
          });
        } catch {
          // A listener never fails the send.
        }
      }
    });
  }
  const attachments = [...(params.attachments ?? []), ...(screen?.attachments ?? [])];
  const result = call.ctx.sessions.send(
    {
      threadId: params.threadId,
      content: params.content,
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(screen === undefined
        ? {}
        : {
            preamble: screen.preamble,
            images: screen.images,
            taintSources: screen.taintSources,
          }),
      ...(params.replyToMessageId === undefined
        ? {}
        : { replyToMessageId: params.replyToMessageId }),
      ...(mode === undefined ? {} : { mode }),
      deviceId: call.identity.deviceId,
    },
    { emit: call.emit, afterCommit: call.afterCommit },
  );
  if (screen !== undefined) {
    const s = screen;
    call.afterCommit(() => s.commit(params.threadId));
  }
  return result;
}

const ROLE_LABEL: Record<Message["role"], string> = {
  user: "You",
  agent: "Psyche",
  system: "System",
  tool: "Tool",
};

function blockToMarkdown(block: Block): string {
  switch (block.type) {
    case "text":
      return block.md;
    case "tool_call":
      return `> ${block.tool}: ${block.level1} (${block.status})`;
    case "checklist":
      return block.items
        .map((i) => `- [${i.status === "completed" ? "x" : " "}] ${i.text}`)
        .join("\n");
    case "wrap_up":
      return [`> ${block.recap}`, ...(block.ask ? [`> ${block.ask}`] : [])].join("\n");
    case "file":
      return `[file ${block.libraryItemId}]`;
    case "artifact":
      return `[artifact ${block.artifactId}${block.preview ? `: ${block.preview}` : ""}]`;
    case "approval":
      return `[approval ${block.approvalId}]`;
    case "question":
      return `[question ${block.inputRequestId}]`;
    case "receipt":
      return `[receipt ${block.receiptId}]`;
    case "plan":
      return `[plan ${block.planId}]`;
    case "task":
      return `[task ${block.taskId}]`;
    case "compaction":
      return `[compacted ${block.replaced.turns} earlier turns: ${block.summary.decisions.length} decisions, ${block.summary.openTasks.length} open tasks]`;
    case "learned":
      return `[learned: ${block.items.map((i) => i.text).join("; ")}]`;
    case "taught":
      return block.statement === null ? "[noted feedback]" : `[will remember: ${block.statement}]`;
    case "related_threads":
      return `[from your other chats: ${block.items.map((i) => i.title || i.threadId).join(", ")}]`;
    case "specialist_result":
      return `[specialist result: ${block.taskId}]`;
  }
}

export function transcriptMarkdown(thread: Thread, messages: readonly Message[]): string {
  const lines = [`# ${thread.title || "Untitled thread"}`, ""];
  if (thread.forkedFromMessageId) lines.push(`_Forked from thread ${thread.parentThreadId}_`, "");
  for (const message of messages) {
    lines.push(`**${ROLE_LABEL[message.role]}** · ${message.createdAt}`, "");
    lines.push(message.blocks.map(blockToMarkdown).join("\n\n"), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export const chatHandlers: Record<string, HandlerDef> = {
  "chat.send": {
    transactional: true,
    run: (
      call: Call,
      params: {
        threadId: string;
        content: string;
        attachments?: string[];
        mode?: QueueMode;
        replyToMessageId?: string;
        redo?: { messageId: string; instruction?: string; withoutLessons?: boolean };
        screen?: ChatScreenRef;
      },
    ) => send(call, params, params.mode),
  },
  "chat.greet": {
    transactional: true,
    run: (call: Call, params: { threadId: string }) => {
      requireThread(call, params.threadId);
      return call.ctx.sessions.greet(params.threadId, {
        emit: call.emit,
        afterCommit: call.afterCommit,
      });
    },
  },
  "chat.steer": {
    transactional: true,
    run: (call: Call, params: { threadId: string; content: string }) => ({
      messageId: send(call, params, "steer").messageId,
    }),
  },
  "chat.followUp": {
    transactional: true,
    run: (call: Call, params: { threadId: string; content: string }) => ({
      messageId: send(call, params, "followUp").messageId,
    }),
  },
  "chat.cancel": {
    async run(call: Call, params: { threadId: string; runId?: string }) {
      requireThread(call, params.threadId);
      return { cancelled: await call.ctx.sessions.cancel(params.threadId, params.runId) };
    },
  },
  "chat.history": {
    run(call: Call, params: { threadId: string; cursor?: string; limit?: number }) {
      requireThread(call, params.threadId);
      const beforeSeq = decodeSeqCursor(params.cursor);
      const page = listMessagesPage(call.ctx.db, params.threadId, {
        limit: Math.min(params.limit ?? DEFAULT_PAGE, MAX_PAGE),
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      });
      return {
        messages: page.messages,
        nextCursor: page.nextBeforeSeq === null ? null : `s${page.nextBeforeSeq}`,
      };
    },
  },
  "chat.queue.list": {
    run(call: Call, params: { threadId: string }) {
      requireThread(call, params.threadId);
      return { items: listQueue(call.ctx.db, params.threadId) };
    },
  },
  "chat.queue.remove": {
    transactional: true,
    run(call: Call, params: { threadId: string; messageId: string }) {
      requireThread(call, params.threadId);
      return {
        removed: call.ctx.sessions.removeQueued(params.threadId, params.messageId, {
          emit: call.emit,
          afterCommit: call.afterCommit,
        }),
      };
    },
  },
  "chat.export": {
    run(call: Call, params: { threadId: string; format: "markdown" | "json" }) {
      const thread = requireThread(call, params.threadId);
      const messages = listAllMessages(call.ctx.db, thread.id);
      if (params.format === "json") {
        return { mime: "application/json", content: JSON.stringify({ thread, messages }, null, 2) };
      }
      return {
        mime: "text/markdown; charset=utf-8",
        content: transcriptMarkdown(thread, messages),
      };
    },
  },
};
