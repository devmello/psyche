import { getWidgets, listAllMessages, listMessagesPage, listQueue } from "@psyche/db";
import {
  type Block,
  type ChatContextRef,
  type ChatScreenRef,
  type Message,
  PsycheError,
  type QueueMode,
  type TaintSource,
  type Thread,
} from "@psyche/protocol";
import type { Call, HandlerDef, ResolvedChatContext, ResolvedScreen } from "../context.ts";
import { requireThread } from "./threads.ts";

const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

function decodeSeqCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const n = /^s(\d{1,12})$/.exec(cursor)?.[1];
  if (n === undefined) throw new PsycheError("invalid_params", "bad cursor");
  return Number(n);
}

const WIDGET_REPLY_MS = 1000;
const lastWidgetReply = new Map<string, number>();

/** The widget's taint sources (possibly none) once the reply is allowed; throws otherwise. */
function widgetReply(call: Call, threadId: string, widgetId: string): TaintSource[] {
  const [widget] = getWidgets(call.ctx.db, [widgetId]);
  // Another chat's widget looks like a missing one: ids cannot be probed.
  if (widget === undefined || widget.threadId !== threadId) {
    throw new PsycheError("not_found", "That widget is not in this chat.");
  }
  const now = Date.now();
  if (now - (lastWidgetReply.get(widgetId) ?? 0) < WIDGET_REPLY_MS) {
    throw new PsycheError("rate_limited", "That widget just sent a reply; wait a moment.", {
      retryable: true,
    });
  }
  lastWidgetReply.set(widgetId, now);
  if (lastWidgetReply.size > 500) lastWidgetReply.clear();
  return widget.taint.map((s) => ({ ...s }));
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
    context?: ChatContextRef;
    fromWidget?: { widgetId: string };
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
  // Ask about this: the feed item's untrusted text, the card for the transcript, and its taint.
  let context: ResolvedChatContext | undefined;
  if (params.context !== undefined) {
    const resolve = call.ctx.chatContext.resolve;
    if (resolve === null)
      throw new PsycheError("unavailable", "Ask about this is not available here");
    context = resolve(params.context);
  }
  // A click on a widget (generative-ui-2026 §6.2): same chat only, one a second, and an untrusted
  // widget taints the turn it starts (§7.3): the owner's click does not launder agent-chosen text.
  const fromWidget =
    params.fromWidget === undefined
      ? undefined
      : widgetReply(call, params.threadId, params.fromWidget.widgetId);
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
      ...(fromWidget === undefined
        ? {}
        : {
            via: "widget" as const,
            ...(fromWidget.length === 0 ? {} : { taintSources: fromWidget }),
          }),
      ...(screen === undefined && context === undefined
        ? {}
        : {
            preamble: [screen?.preamble, context?.preamble]
              .filter((p): p is string => p !== undefined)
              .join("\n\n"),
            taintSources: [...(screen?.taintSources ?? []), ...(context?.taintSources ?? [])],
          }),
      ...(screen === undefined ? {} : { images: screen.images }),
      ...(context === undefined ? {} : { contextBlocks: [context.block] }),
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
    case "context":
      return `[about: ${block.title}${block.url === undefined ? "" : ` ${block.url}`}]`;
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
    case "sources":
      return `[sources: ${block.items.map((i) => i.title || i.id).join("; ")}]`;
    case "specialist_result":
      return `[specialist result: ${block.taskId}]`;
    case "app_link":
      return `[open in the app: ${block.route}]`;
    case "ui":
      return `[widget ${block.widgetId}]`;
    case "automation_workflow":
      return [
        `> Proposed automation: ${block.proposal.title}`,
        ...block.proposal.runs.map((r) => `> - ${r.name}: ${r.humanSchedule}`),
      ].join("\n");
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
        context?: ChatContextRef;
        fromWidget?: { widgetId: string };
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
