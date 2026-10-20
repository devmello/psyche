import {
  AssistantRuntimeProvider,
  getExternalStoreMessages,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { Message, QueueMode } from "@psyche/protocol";
import { X } from "lucide-react";
import { type ReactElement, useCallback, useMemo, useRef, useState } from "react";
import { MODE_LABEL } from "../agent/AgentHeader.tsx";
import { type DisclosureLevel, DisclosureProvider } from "../blocks/disclosure.tsx";
import { useCall, useConnection, useStoreState, useThread, useThreads } from "../data/index.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { cn } from "../lib/utils.ts";
import { usePersona, useSlots } from "../slots.tsx";
import { ApprovalDock } from "./ApprovalDock.tsx";
import { Composer } from "./Composer.tsx";
import { type CommandName, parseCommand } from "./commands.ts";
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
  /** Transcript view mode (E11): 0 tools collapsed, 1 actions, 2 raw I/O. Uncontrolled when absent. */
  disclosure?: DisclosureLevel;
  onDisclosureChange?: (level: DisclosureLevel) => void;
}

/** `/incognito [first message]` typed in the composer (UI design §3.2, feature E9). */
export function parseIncognitoCommand(text: string): { text: string } | null {
  const m = /^\/incognito(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (m === null) return null;
  return { text: (m[1] ?? "").trim() };
}

/** The result of a composer command, shown above the composer until dismissed. */
export interface CommandNotice {
  kind: "info" | "ok" | "error";
  text: string;
  /** A confirmation step (for example `/forget` after its dry run). */
  confirm?: { label: string; run: () => Promise<void> };
}

function codeOf(err: unknown): string | undefined {
  const c = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof c === "string" ? c : undefined;
}

function download(filename: string, mime: string, content: string): void {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function NoticeBar({
  notice,
  onDismiss,
}: {
  notice: CommandNotice;
  onDismiss: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  return (
    <div
      role={notice.kind === "error" ? "alert" : "status"}
      data-testid="command-notice"
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        notice.kind === "error" ? "border-danger/40 text-danger-text" : "border-gray-6 bg-gray-2",
      )}
    >
      <p className="min-w-0 flex-1 whitespace-pre-line">{notice.text}</p>
      {notice.confirm ? (
        <button
          type="button"
          disabled={busy}
          className="rounded-md border border-input bg-background px-2 py-0.5 text-xs font-medium hover:bg-gray-3"
          onClick={() => {
            setBusy(true);
            void notice.confirm?.run().finally(() => setBusy(false));
          }}
        >
          {notice.confirm.label}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-gray-4"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The chat column (UI design §3.1–§3.3) on assistant-ui's external-store runtime: our store owns
 * the messages; assistant-ui provides the viewport (autoscroll), the message list and the
 * composer primitives. Blocks render through `MessageBlocks`, never through assistant-ui parts.
 */
export function ChatThread({
  threadId,
  onAttach,
  onDictate,
  now,
  disclosure,
  onDisclosureChange,
}: ChatThreadProps): ReactElement {
  const view = useThread(threadId);
  const { fork, create } = useThreads();
  const call = useCall();
  const { navigate } = useSlots();
  const { state: connection } = useConnection();
  const tasks = useStoreState((s) => s.tasks);
  const persona = usePersona();
  const [quoting, setQuoting] = useState<Message | null>(null);
  const [mode, setMode] = useState<QueueMode>("followUp");
  const [notice, setNotice] = useState<CommandNotice | null>(null);
  const offline = connection !== "open";

  const display = useMemo<DisplayMessage[]>(() => {
    const byId = new Map(view.messages.map((m) => [m.id, m]));
    const out: DisplayMessage[] = view.messages.map((m) => ({
      message: m,
      streamingText: null,
    }));
    for (const s of view.streaming) {
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
  }, [view.messages, view.streaming, threadId, now]);

  const latestChecklistId = useMemo(() => {
    for (let i = display.length - 1; i >= 0; i--) {
      const d = display[i];
      if (d?.message.blocks.some((b) => b.type === "checklist")) return d.message.id;
    }
    return null;
  }, [display]);

  // The command runner reads this render's thread state; onNew calls the latest one.
  const runCommandRef = useRef<(name: CommandName, arg: string) => Promise<void>>(async () => {});

  const onNew = useCallback(
    async (append: { content: readonly { type: string; text?: string }[] }) => {
      const text = append.content
        .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
        .join("")
        .trim();
      if (text === "") return;
      const parsed = parseCommand(text);
      if (parsed.type === "error") {
        setNotice({ kind: "error", text: parsed.message });
        return;
      }
      if (parsed.type === "command") {
        setNotice(null);
        try {
          await runCommandRef.current(parsed.name, parsed.arg);
        } catch (err) {
          setNotice({
            kind: "error",
            text: t("chat.command.failed", { name: parsed.name, reason: describeError(err) }),
          });
        }
        return;
      }
      await view.send(parsed.text, { mode, replyToMessageId: quoting?.id ?? null });
      setQuoting(null);
      setMode("followUp");
    },
    [view, mode, quoting],
  );

  runCommandRef.current = runCommand;

  /** Composer commands (feature C9), executed with protocol methods. */
  async function runCommand(name: CommandName, arg: string): Promise<void> {
    const thread = view.thread?.thread;
    const openThread = (id: string) => navigate?.(`/chat/${id}`);
    /** `threads.update` with the outcome as a notice; true when the thread changed. */
    const updateThread = async (
      params: { modelRef?: string | null; permissionMode?: "plan" },
      done: string,
    ): Promise<boolean> => {
      try {
        await call("threads.update", { threadId, ...params });
        setNotice({ kind: "ok", text: done });
        return true;
      } catch (err) {
        setNotice({
          kind: "error",
          text:
            codeOf(err) === "unknown_method"
              ? t("chat.command.newerGateway")
              : t("chat.command.didntWork", { reason: describeError(err) }),
        });
        return false;
      }
    };
    switch (name) {
      case "model": {
        if (arg === "") {
          setNotice({
            kind: "info",
            text: t("chat.command.modelCurrent", {
              model: thread?.modelRef ?? t("chat.command.defaultModel"),
            }),
          });
          return;
        }
        await updateThread({ modelRef: arg }, t("chat.command.modelSet", { model: arg }));
        return;
      }
      case "plan": {
        const ok = await updateThread({ permissionMode: "plan" }, t("chat.command.planMode"));
        if (ok && arg !== "") await view.send(arg);
        return;
      }
      case "new": {
        const created = await create({ kind: "side" });
        openThread(created.id);
        return;
      }
      case "btw": {
        const created = await create({
          kind: "side",
          parentThreadId: threadId,
          title: arg.slice(0, 60),
        });
        await call("chat.send", { threadId: created.id, content: arg });
        openThread(created.id);
        return;
      }
      case "fork": {
        const last = view.messages.at(-1);
        const forked = last
          ? await fork(threadId, last.id)
          : await create({ kind: "side", parentThreadId: threadId });
        if (arg !== "") await call("chat.send", { threadId: forked.id, content: arg });
        openThread(forked.id);
        return;
      }
      case "incognito": {
        // A memory-only side chat that expires after 24 h (E9); the first message goes there.
        const created = await create({ kind: "incognito", parentThreadId: threadId });
        if (arg !== "") await call("chat.send", { threadId: created.id, content: arg });
        openThread(created.id);
        return;
      }
      case "schedule": {
        // The agent turns the sentence into a schedule with its `schedule` tool (an approval).
        // Sent to the agent, which reads English instructions; not UI text.
        await view.send(
          `/schedule ${arg}\n\nCreate this as an automation with your schedule tool, then tell me what you set up.`,
        );
        return;
      }
      case "remember": {
        const res = await call("memory.remember", { text: arg });
        setNotice({ kind: "ok", text: t("chat.command.noted", { path: res.path }) });
        return;
      }
      case "forget": {
        const preview = await call("memory.forget", { subject: arg, dryRun: true });
        const claims = preview.retractedClaimIds.length;
        const chunks = preview.removedChunkIds.length;
        if (claims === 0 && chunks === 0 && preview.files.length === 0) {
          setNotice({ kind: "info", text: t("chat.command.nothingMatches", { subject: arg }) });
          return;
        }
        setNotice({
          kind: "info",
          text: t("chat.command.forgetPreview", {
            subject: arg,
            claims,
            chunks,
            files: activeI18n().list(preview.files),
            hasFiles: preview.files.length > 0,
          }),
          confirm: {
            label: t("chat.command.forget"),
            run: async () => {
              try {
                await call("memory.forget", { subject: arg });
                setNotice({ kind: "ok", text: t("chat.command.forgot", { subject: arg }) });
              } catch (err) {
                setNotice({
                  kind: "error",
                  text: t("chat.command.forgetFailed", { reason: describeError(err) }),
                });
              }
            },
          },
        });
        return;
      }
      case "status": {
        const running = Object.values(tasks).filter((x) => x.status === "running").length;
        setNotice({
          kind: "info",
          text: [
            t("chat.command.status.model", {
              model: thread?.modelRef ?? t("chat.command.status.default"),
            }),
            t("chat.command.status.mode", {
              mode: MODE_LABEL[thread?.permissionMode ?? "balanced"],
            }),
            t("chat.command.status.chat", { state: view.running ? "working" : "idle" }),
            t("chat.command.status.tasks", { n: running }),
          ].join("\n"),
        });
        return;
      }
      case "export": {
        const json = arg.toLowerCase() === "json";
        const res = await call("chat.export", { threadId, format: json ? "json" : "markdown" });
        const base = (thread?.title || "thread").replace(/[^\w.-]+/g, "-").slice(0, 60);
        download(`${base}.${json ? "json" : "md"}`, res.mime, res.content);
        setNotice({
          kind: "ok",
          text: t("chat.command.exported", { format: json ? "JSON" : "Markdown" }),
        });
        return;
      }
      case "stop": {
        if (!view.running) {
          setNotice({ kind: "info", text: t("chat.command.nothingRunning") });
          return;
        }
        await view.cancel();
        setNotice({ kind: "ok", text: t("chat.command.stopped") });
        return;
      }
    }
  }

  const runtime = useExternalStoreRuntime<DisplayMessage>({
    messages: display,
    // The follow-up queue is ours (client-side, removable), so the runtime never blocks sending.
    isRunning: false,
    isDisabled: offline,
    hasEarlier: view.hasMore,
    onLoadEarlier: view.loadOlder,
    onNew,
    convertMessage: (d) => ({
      id: d.message.id,
      role:
        d.message.role === "user" ? "user" : d.message.role === "system" ? "system" : "assistant",
      content: [{ type: "text", text: d.streamingText ?? "" }],
      createdAt: new Date(d.message.createdAt),
    }),
  });

  const byId = useMemo(() => new Map(view.messages.map((m) => [m.id, m])), [view.messages]);

  /**
   * Edit and resend (E5): a side chat forked just before the edited message (or a fresh side
   * chat when it was the first), the edited text sent there, then navigation to it. The
   * original thread keeps its transcript.
   */
  const editAndResend = useCallback(
    async (message: Message, text: string) => {
      const index = view.messages.findIndex((m) => m.id === message.id);
      const before = index > 0 ? view.messages[index - 1] : undefined;
      const thread = before
        ? await fork(threadId, before.id)
        : await create({ kind: "side", parentThreadId: threadId });
      await call("chat.send", { threadId: thread.id, content: text });
      navigate?.(`/chat/${thread.id}`);
    },
    [view.messages, threadId, fork, create, call, navigate],
  );

  return (
    <DisclosureProvider
      {...(disclosure === undefined ? {} : { level: disclosure })}
      {...(onDisclosureChange === undefined ? {} : { onLevelChange: onDisclosureChange })}
    >
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
              {display.length === 0 && !view.loading ? (
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
                      onEdit={(msg, text) => void editAndResend(msg, text)}
                      onJumpTo={(id) =>
                        document
                          .getElementById(`message-${id}`)
                          ?.scrollIntoView({ block: "center" })
                      }
                      onWrapUpAction={(text) => void view.send(text)}
                    />
                  );
                }}
              </ThreadPrimitive.Messages>
            </div>
          </ThreadPrimitive.Viewport>
          <div className="mx-auto flex w-full max-w-[calc(var(--prose-width)+3rem)] flex-col gap-2 px-4 pb-3">
            <ApprovalDock
              threadId={threadId}
              {...(view.thread ? { mode: view.thread.thread.permissionMode } : {})}
              {...(now === undefined ? {} : { now })}
            />
            <FollowUpQueue
              items={view.queue}
              onRemove={view.removeQueued}
              onRetry={view.retryQueued}
              onSendNow={(q, m) => {
                view.removeQueued(q.id);
                void view.send(q.content, { mode: m, replyToMessageId: q.replyToMessageId });
              }}
            />
            {notice ? <NoticeBar notice={notice} onDismiss={() => setNotice(null)} /> : null}
            <Composer
              persona={persona.name}
              running={view.running}
              disabled={offline}
              quoting={quoting}
              onClearQuote={() => setQuoting(null)}
              mode={mode}
              onStop={() => void view.cancel()}
              {...(onAttach ? { onAttach } : {})}
              {...(onDictate ? { onDictate } : {})}
            />
          </div>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </DisclosureProvider>
  );
}
