import {
  AssistantRuntimeProvider,
  getExternalStoreMessages,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { Message, QueueMode } from "@psyche/protocol";
import { type ReactElement, useCallback, useMemo, useState } from "react";
import { DisclosureProvider } from "../blocks/disclosure.tsx";
import { useConnection, useStoreState, useThread, useThreads } from "../data/index.ts";
import { usePersona } from "../slots.tsx";
import { ApprovalDock } from "./ApprovalDock.tsx";
import { Composer } from "./Composer.tsx";
import { FollowUpQueue } from "./FollowUpQueue.tsx";
import { MessageView } from "./MessageView.tsx";
import { OfflineBanner } from "./OfflineBanner.tsx";

/** A committed message, or a streaming one that has no committed blocks yet. */
interface DisplayMessage {
  message: Message;
  streamingText: string | null;
}

export interface ChatThreadProps {
  threadId: string;
  onAttach?: () => void;
  onDictate?: () => void;
  /** Fixed clock for cards (stories, tests). */
  now?: number;
}

/**
 * The chat column (UI design §3.1–§3.3) on assistant-ui's external-store runtime: our store owns
 * the messages; assistant-ui provides the viewport (autoscroll), the message list and the
 * composer primitives. Blocks render through `MessageBlocks`, never through assistant-ui parts.
 */
export function ChatThread({ threadId, onAttach, onDictate, now }: ChatThreadProps): ReactElement {
  const t = useThread(threadId);
  const { fork } = useThreads();
  const { state: connection } = useConnection();
  const tasks = useStoreState((s) => s.tasks);
  const persona = usePersona();
  const [quoting, setQuoting] = useState<Message | null>(null);
  const [mode, setMode] = useState<QueueMode>("followUp");
  const offline = connection !== "open";

  const display = useMemo<DisplayMessage[]>(() => {
    const byId = new Map(t.messages.map((m) => [m.id, m]));
    const out: DisplayMessage[] = t.messages.map((m) => ({
      message: m,
      streamingText: null,
    }));
    for (const s of t.streaming) {
      const committed = byId.get(s.messageId);
      if (committed !== undefined) {
        const entry = out.find((d) => d.message.id === s.messageId);
        if (entry) entry.streamingText = s.text;
        continue;
      }
      out.push({
        message: {
          id: s.messageId,
          threadId,
          seq: Number.MAX_SAFE_INTEGER,
          role: "agent",
          blocks: [],
          providerNative: null,
          provenance: "agent",
          replyToMessageId: null,
          channelRef: null,
          runId: s.runId,
          createdAt: new Date(now ?? Date.now()).toISOString(),
        },
        streamingText: s.text,
      });
    }
    return out;
  }, [t.messages, t.streaming, threadId, now]);

  const latestChecklistId = useMemo(() => {
    for (let i = display.length - 1; i >= 0; i--) {
      const d = display[i];
      if (d?.message.blocks.some((b) => b.type === "checklist")) return d.message.id;
    }
    return null;
  }, [display]);

  const onNew = useCallback(
    async (append: { content: readonly { type: string; text?: string }[] }) => {
      const text = append.content
        .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
        .join("")
        .trim();
      if (text === "") return;
      await t.send(text, { mode, replyToMessageId: quoting?.id ?? null });
      setQuoting(null);
      setMode("followUp");
    },
    [t, mode, quoting],
  );

  const runtime = useExternalStoreRuntime<DisplayMessage>({
    messages: display,
    // The follow-up queue is ours (client-side, removable), so the runtime never blocks sending.
    isRunning: false,
    isDisabled: offline,
    hasEarlier: t.hasMore,
    onLoadEarlier: t.loadOlder,
    onNew,
    convertMessage: (d) => ({
      id: d.message.id,
      role:
        d.message.role === "user" ? "user" : d.message.role === "system" ? "system" : "assistant",
      content: [{ type: "text", text: d.streamingText ?? "" }],
      createdAt: new Date(d.message.createdAt),
    }),
  });

  const byId = useMemo(() => new Map(t.messages.map((m) => [m.id, m])), [t.messages]);

  return (
    <DisclosureProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="flex h-full min-w-[min(100%,var(--chat-min-width))] flex-col">
          {offline ? <OfflineBanner state={connection} /> : null}
          <ThreadPrimitive.Viewport
            className="flex-1 overflow-y-auto px-4 py-3"
            aria-label="Conversation"
            role="log"
          >
            {/*
              Short conversations sit just above the composer, as in a messaging app, instead
              of leaving an empty band between the last message and the composer; long ones
              scroll as usual.
            */}
            <div
              className="mx-auto flex min-h-full w-full max-w-[calc(var(--prose-width)+3rem)] flex-col justify-end"
              data-testid="conversation-column"
            >
              {display.length === 0 && !t.loading ? (
                // Empty state (UI design §3.0): one sentence in Psyche's voice; the composer
                // below is the one action. The main chat is never empty (it opens with the
                // agent's first message), so this is a new side chat.
                <p
                  className="py-6 text-center text-sm text-muted-foreground"
                  data-testid="chat-empty"
                >
                  Nothing here yet. Ask {persona.name} something below to start.
                </p>
              ) : null}
              <ThreadPrimitive.Messages>
                {({ message }) => {
                  const [d] = getExternalStoreMessages<DisplayMessage>(message);
                  if (d === undefined) return null;
                  const m = d.message;
                  const prev = display[display.indexOf(d) - 1]?.message;
                  const lead = m.blocks[0];
                  const fromTask =
                    m.role === "agent" && m.runId === null && lead?.type === "task"
                      ? (tasks[lead.taskId] ?? null)
                      : null;
                  return (
                    <MessageView
                      message={m}
                      streamingText={d.streamingText}
                      quoted={m.replyToMessageId ? (byId.get(m.replyToMessageId) ?? null) : null}
                      fromTask={fromTask}
                      pinChecklist={m.id === latestChecklistId}
                      showHeader={
                        prev?.role !== "agent" || fromTask !== null || prev.runId !== m.runId
                      }
                      onReply={setQuoting}
                      onFork={(msg) => void fork(threadId, msg.id)}
                      onJumpTo={(id) =>
                        document
                          .getElementById(`message-${id}`)
                          ?.scrollIntoView({ block: "center" })
                      }
                      onWrapUpAction={(text) => void t.send(text)}
                    />
                  );
                }}
              </ThreadPrimitive.Messages>
            </div>
          </ThreadPrimitive.Viewport>
          <div className="mx-auto flex w-full max-w-[calc(var(--prose-width)+3rem)] flex-col gap-2 px-4 pb-3">
            <ApprovalDock
              threadId={threadId}
              {...(t.thread ? { mode: t.thread.thread.permissionMode } : {})}
              {...(now === undefined ? {} : { now })}
            />
            <FollowUpQueue items={t.queue} onRemove={t.removeQueued} onRetry={t.retryQueued} />
            <Composer
              persona={persona.name}
              running={t.running}
              disabled={offline}
              quoting={quoting}
              onClearQuote={() => setQuoting(null)}
              mode={mode}
              onModeChange={setMode}
              onStop={() => void t.cancel()}
              {...(onAttach ? { onAttach } : {})}
              {...(onDictate ? { onDictate } : {})}
            />
          </div>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </DisclosureProvider>
  );
}
