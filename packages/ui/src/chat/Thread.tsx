import {
  AssistantRuntimeProvider,
  getExternalStoreMessages,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { Message, QueueMode } from "@psyche/protocol";
import { X } from "lucide-react";
import { type ReactElement, useCallback, useMemo, useRef, useState } from "react";
import { type DisclosureLevel, DisclosureProvider } from "../blocks/disclosure.tsx";
import { useCall, useConnection, useStoreState, useThread, useThreads } from "../data/index.ts";
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
        className="rounded p-0.5 text-muted-foreground hover:bg-gray-4"
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
  const t = useThread(threadId);
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
            text: `/${parsed.name} didn't work (${messageOf(err)}). Nothing was changed.`,
          });
        }
        return;
      }
      await t.send(parsed.text, { mode, replyToMessageId: quoting?.id ?? null });
      setQuoting(null);
      setMode("followUp");
    },
    [t, mode, quoting],
  );

  runCommandRef.current = runCommand;

  /** Composer commands (feature C9), executed with protocol methods. */
  async function runCommand(name: CommandName, arg: string): Promise<void> {
    const thread = t.thread?.thread;
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
              ? "This needs a newer Gateway."
              : `That didn't work (${messageOf(err)}). Nothing was changed.`,
        });
        return false;
      }
    };
    switch (name) {
      case "model": {
        if (arg === "") {
          setNotice({
            kind: "info",
            text: `This thread uses ${thread?.modelRef ?? "the default model"}. Type /model provider/model to pick another.`,
          });
          return;
        }
        await updateThread({ modelRef: arg }, `This thread now uses ${arg}.`);
        return;
      }
      case "plan": {
        const ok = await updateThread(
          { permissionMode: "plan" },
          "Plan mode: read-only until you switch back.",
        );
        if (ok && arg !== "") await t.send(arg);
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
        const last = t.messages.at(-1);
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
        await t.send(
          `/schedule ${arg}\n\nCreate this as an automation with your schedule tool, then tell me what you set up.`,
        );
        return;
      }
      case "remember": {
        const res = await call("memory.remember", { text: arg });
        setNotice({ kind: "ok", text: `Noted in ${res.path}.` });
        return;
      }
      case "forget": {
        const preview = await call("memory.forget", { subject: arg, dryRun: true });
        const claims = preview.retractedClaimIds.length;
        const chunks = preview.removedChunkIds.length;
        if (claims === 0 && chunks === 0 && preview.files.length === 0) {
          setNotice({ kind: "info", text: `Nothing remembered matches "${arg}".` });
          return;
        }
        const files = preview.files.length > 0 ? `, editing ${preview.files.join(", ")}` : "";
        setNotice({
          kind: "info",
          text: `Forgetting "${arg}" retracts ${claims} claim${claims === 1 ? "" : "s"} and ${chunks} indexed note${chunks === 1 ? "" : "s"}${files}.`,
          confirm: {
            label: "Forget",
            run: async () => {
              try {
                await call("memory.forget", { subject: arg });
                setNotice({ kind: "ok", text: `Forgot "${arg}".` });
              } catch (err) {
                setNotice({
                  kind: "error",
                  text: `Forgetting didn't work (${messageOf(err)}). Nothing was changed.`,
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
            `Model: ${thread?.modelRef ?? "default"}`,
            `Mode: ${thread?.permissionMode ?? "balanced"}`,
            `This chat: ${t.running ? "working" : "idle"}`,
            `Running tasks: ${running}`,
          ].join("\n"),
        });
        return;
      }
      case "export": {
        const json = arg.toLowerCase() === "json";
        const res = await call("chat.export", { threadId, format: json ? "json" : "markdown" });
        const base = (thread?.title || "thread").replace(/[^\w.-]+/g, "-").slice(0, 60);
        download(`${base}.${json ? "json" : "md"}`, res.mime, res.content);
        setNotice({ kind: "ok", text: `Exported this thread as ${json ? "JSON" : "Markdown"}.` });
        return;
      }
      case "stop": {
        if (!t.running) {
          setNotice({ kind: "info", text: "Nothing is running in this chat." });
          return;
        }
        await t.cancel();
        setNotice({ kind: "ok", text: "Stopped." });
        return;
      }
    }
  }

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

  /**
   * Edit and resend (E5): a side chat forked just before the edited message (or a fresh side
   * chat when it was the first), the edited text sent there, then navigation to it. The
   * original thread keeps its transcript.
   */
  const editAndResend = useCallback(
    async (message: Message, text: string) => {
      const index = t.messages.findIndex((m) => m.id === message.id);
      const before = index > 0 ? t.messages[index - 1] : undefined;
      const thread = before
        ? await fork(threadId, before.id)
        : await create({ kind: "side", parentThreadId: threadId });
      await call("chat.send", { threadId: thread.id, content: text });
      navigate?.(`/chat/${thread.id}`);
    },
    [t.messages, threadId, fork, create, call, navigate],
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
            <div className="mx-auto w-full max-w-[calc(var(--prose-width)+3rem)]">
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
            {notice ? <NoticeBar notice={notice} onDismiss={() => setNotice(null)} /> : null}
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
