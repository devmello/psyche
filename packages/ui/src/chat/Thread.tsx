import {
  AssistantRuntimeProvider,
  getExternalStoreMessages,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { Message, QueueMode, SpecialistJob } from "@psyche/protocol";
import { CircleAlert, X } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DisclosureLevel, DisclosureProvider } from "../blocks/disclosure.tsx";
import { indexThreadBlocks, ThreadBlocksProvider } from "../blocks/thread-blocks.tsx";
import {
  type GatewayCall,
  useCall,
  useConnection,
  useGatewayQuery,
  useRunsList,
  useSpecialistJobs,
  useSpecialistRoles,
  useStore,
  useStoreState,
  useThread,
  useThreads,
} from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { LayoutMotion, Presence } from "../motion/index.ts";
import { usePersona, useSlots } from "../slots.tsx";
import { SpecialistSpawns } from "../specialists/SpawnLine.tsx";
import { VoiceComposer } from "../voice/composer-voice.tsx";
import { ApprovalDock } from "./ApprovalDock.tsx";
import { attachSupport, modelCapabilities, uploadFile } from "./attachments.ts";
import { type CommandName, parseCommand } from "./commands.ts";
import { FollowUpQueue } from "./FollowUpQueue.tsx";
import { MessageView } from "./MessageView.tsx";
import { OfflineBanner } from "./OfflineBanner.tsx";
import { ComposerPrefill } from "./prefill.ts";
import { failureAnchors, RunFailure } from "./RunFailure.tsx";
import { RunStepLog, useRunSteps } from "./RunStepLog.tsx";
import { RunTrace } from "./steps/RunTrace.tsx";
import {
  ComposerSuggestions,
  EmptyThread,
  JumpToLatest,
  useElementHeight,
} from "./ThreadChrome.tsx";
import { TranscriptSkeleton } from "./TranscriptSkeleton.tsx";
import { useAttachments } from "./useAttachments.ts";
import { useBottomAnchor } from "./useBottomAnchor.ts";
import { useRunningTool } from "./WorkingIndicator.tsx";

/** A committed message, or a streaming one that has no committed blocks yet. */
interface DisplayMessage {
  message: Message;
  streamingText: string | null;
}

export interface ChatThreadProps {
  threadId: string;
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
      // Level 1; an error uses danger only for its icon, the sentence stays primary (§3.3).
      className="flex items-start gap-2 rounded-lg bg-surface-raised px-3 py-2 text-body text-label-primary shadow-elevation-1"
    >
      {notice.kind === "error" ? (
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger-text" aria-hidden="true" />
      ) : null}
      <p className="min-w-0 flex-1 whitespace-pre-line">{notice.text}</p>
      {notice.confirm ? (
        <button
          type="button"
          disabled={busy}
          className="cursor-default rounded-sm bg-fill-secondary px-2 py-0.5 text-callout font-medium text-label-primary hover:bg-fill-primary"
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
        aria-label={t("common.dismiss")}
        className="inline-flex size-6 cursor-default items-center justify-center rounded-sm text-label-secondary hover:bg-fill-tertiary"
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
  const store = useStore();
  // "Ask about this" (Feed): the chip waits in the store until this thread's first message.
  const askContext = useStoreState((s) =>
    s.composerContext?.threadId === threadId ? s.composerContext : null,
  );
  const clearAskContext = useCallback(
    () =>
      store.update((s) =>
        s.composerContext?.threadId === threadId ? { ...s, composerContext: null } : s,
      ),
    [store, threadId],
  );
  // #548: from a send until the run settles the thread says it is working, even before the
  // Gateway's first run event or token arrives.
  const [sentAt, setSentAt] = useState<number | null>(null);
  const sawRun = useRef(false);
  const runningTool = useRunningTool(threadId);
  const persona = usePersona();
  const [quoting, setQuoting] = useState<Message | null>(null);
  const [mode, setMode] = useState<QueueMode>("followUp");
  const [notice, setNotice] = useState<CommandNotice | null>(null);
  const offline = connection !== "open";
  // The + button shows when the thread's model can take files (unknown shows it; documents work
  // on any chat model, images need vision). Capabilities come from `models.list`: no new probe.
  const models = useGatewayQuery("models.list", {});
  const support = attachSupport(modelCapabilities(models.data, view.thread?.thread.modelRef));
  const attachments = useAttachments(support, (file, signal) =>
    uploadFile(call as GatewayCall, file, { threadId, signal }),
  );

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

  const lastAgentAt = useMemo(() => {
    for (let i = display.length - 1; i >= 0; i--) {
      const d = display[i];
      if (d?.message.role === "agent")
        return d.streamingText ? Infinity : Date.parse(d.message.createdAt);
    }
    return 0;
  }, [display]);
  useEffect(() => {
    if (sentAt === null) {
      sawRun.current = false;
      return;
    }
    if (view.running) {
      sawRun.current = true;
      return;
    }
    // Settled: the run ran and stopped, or a reply arrived without a run event.
    if (sawRun.current || lastAgentAt >= sentAt) {
      setSentAt(null);
      return;
    }
    // No run ever reported: stop claiming work after a while rather than spin forever.
    const timer = setTimeout(() => setSentAt(null), 30_000);
    return () => clearTimeout(timer);
  }, [sentAt, view.running, lastAgentAt]);
  const streamingNow = view.streaming.some((m) => m.text !== "");
  const working = (view.running || sentAt !== null) && (runningTool !== null || !streamingNow);

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
            text: t("chat.thread.commandFailed", {
              name: parsed.name,
              reason: describeError(err),
            }),
          });
        }
        return;
      }
      const queued = view.running && mode === "followUp";
      const replyToMessageId = quoting?.id ?? null;
      // The finished uploads go with this message; the chips clear once it is on its way.
      const sentIds = attachments.ids;
      const sentContext = askContext
        ? {
            ref: askContext.ref,
            block: {
              type: "context" as const,
              kind: "feed_item" as const,
              id: askContext.ref.id,
              title: askContext.title,
              ...(askContext.url ? { url: askContext.url } : {}),
              ...(askContext.source ? { source: askContext.source } : {}),
            },
          }
        : undefined;
      const attempt = async (): Promise<void> => {
        try {
          await view.send(parsed.text, {
            mode,
            replyToMessageId,
            ...(sentIds.length > 0 ? { attachments: sentIds } : {}),
            ...(sentContext ? { context: sentContext } : {}),
          });
        } catch (err) {
          // The optimistic bubble is gone; keep the text one click from going out again.
          setSentAt(null);
          setNotice({
            kind: "error",
            text: t("chat.thread.sendFailed", { reason: describeError(err) }),
            confirm: {
              label: t("chat.thread.retrySend"),
              run: async () => {
                setNotice(null);
                if (!queued) setSentAt(Date.now());
                await attempt();
              },
            },
          });
        }
      };
      if (!queued) setSentAt(Date.now());
      setQuoting(null);
      setMode("followUp");
      attachments.clear();
      clearAskContext();
      await attempt();
    },
    [view, mode, quoting, attachments.ids, attachments.clear, askContext, clearAskContext],
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
              ? t("chat.thread.needsNewerGateway")
              : t("chat.thread.failed", { reason: describeError(err) }),
        });
        return false;
      }
    };
    switch (name) {
      case "model": {
        if (arg === "") {
          setNotice({
            kind: "info",
            text: thread?.modelRef
              ? t("chat.thread.modelCurrent", { model: thread.modelRef })
              : t("chat.thread.modelCurrentDefault"),
          });
          return;
        }
        await updateThread({ modelRef: arg }, t("chat.thread.modelSet", { model: arg }));
        return;
      }
      case "plan": {
        const ok = await updateThread({ permissionMode: "plan" }, t("chat.thread.planMode"));
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
        await view.send(t("chat.thread.schedulePrompt", { request: arg }));
        return;
      }
      case "remember": {
        const res = await call("memory.remember", { text: arg });
        setNotice({ kind: "ok", text: t("chat.thread.remembered", { path: res.path }) });
        return;
      }
      case "teach": {
        // A correction to the last reply (teaching loop §5.1), like Not like this with text.
        const last = view.messages.findLast((m) => m.role === "agent");
        if (last === undefined) {
          setNotice({ kind: "info", text: t("chat.thread.teachNothing") });
          return;
        }
        const res = await call("feedback.give", {
          target: { type: "message", id: last.id, threadId },
          kind: "correction",
          text: arg,
        });
        setNotice({
          kind: "ok",
          text: res.lesson
            ? t("chat.thread.taught", { lesson: res.lesson.statement })
            : t("chat.teach.noted"),
        });
        return;
      }
      case "forget": {
        const preview = await call("memory.forget", { subject: arg, dryRun: true });
        const claims = preview.retractedClaimIds.length;
        const chunks = preview.removedChunkIds.length;
        if (claims === 0 && chunks === 0 && preview.files.length === 0) {
          setNotice({ kind: "info", text: t("chat.thread.forgetNothing", { subject: arg }) });
          return;
        }
        setNotice({
          kind: "info",
          text: t("chat.thread.forgetPreview", {
            subject: arg,
            claims,
            chunks,
            hasFiles: preview.files.length > 0,
            files: preview.files.join(", "),
          }),
          confirm: {
            label: t("chat.thread.forgetConfirm"),
            run: async () => {
              try {
                await call("memory.forget", { subject: arg });
                setNotice({ kind: "ok", text: t("chat.thread.forgot", { subject: arg }) });
              } catch (err) {
                setNotice({
                  kind: "error",
                  text: t("chat.thread.forgetFailed", { reason: describeError(err) }),
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
          text: t("chat.thread.status", {
            model: thread?.modelRef ?? t("chat.thread.statusDefaultModel"),
            // The permission mode is a protocol value, shown as is.
            mode: thread?.permissionMode ?? "balanced",
            running: view.running,
            tasks: running,
          }),
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
          text: t("chat.thread.exported", {
            format: json ? t("chat.export.json") : t("chat.export.markdown"),
          }),
        });
        return;
      }
      case "stop": {
        if (!view.running) {
          setNotice({ kind: "info", text: t("chat.thread.nothingRunning") });
          return;
        }
        await view.cancel();
        setNotice({ kind: "ok", text: t("chat.thread.stopped") });
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
  // Tool calls and approvals that span an approval pause show once (#569).
  const baseIndex = useMemo(() => indexThreadBlocks(view.messages), [view.messages]);
  // A run's step log while it works (#623): its tool calls and approvals live in the log until
  // the run ends, then fold back into the transcript's grouped rows.
  const streamingText = view.streaming.at(-1)?.text ?? null;
  const { run: stepRun, steps } = useRunSteps(threadId, baseIndex, streamingText);
  // Run trace (T2): runs the store has steps for show them at their anchor above the reply.
  const runSteps = useStoreState((s) => s.runSteps);
  // One `runs.list` per thread says which past runs have steps, so their anchors load them.
  const runFilter = useMemo(() => ({ threadId }), [threadId]);
  const { runs: listedRuns } = useRunsList(runFilter);
  const tracedRuns = useMemo(() => {
    const out = new Set<string>();
    for (const r of listedRuns) if ((r.stepCount ?? 0) > 0) out.add(r.id);
    for (const m of view.messages)
      if (m.runId && (runSteps[m.runId]?.length ?? 0) > 0) out.add(m.runId);
    if (stepRun && (runSteps[stepRun.id]?.length ?? 0) > 0) out.add(stepRun.id);
    return out;
  }, [view.messages, runSteps, stepRun, listedRuns]);
  const blockIndex = useMemo(
    () => ({ ...baseIndex, activeRunId: stepRun?.id ?? null, tracedRuns }),
    [baseIndex, stepRun?.id, tracedRuns],
  );
  // Specialists this thread started (§6.1): one line each after the run that started them.
  const jobFilter = useMemo(() => ({ threadId }), [threadId]);
  const { jobs: spawned } = useSpecialistJobs(jobFilter);
  const { roles: specialistRoles } = useSpecialistRoles();
  const spawnsByRun = useMemo(() => {
    const runIds = new Set(view.messages.map((m) => m.runId));
    const byRun = new Map<string, SpecialistJob[]>();
    const rest: SpecialistJob[] = [];
    for (const job of spawned) {
      if (job.parentRunId != null && runIds.has(job.parentRunId)) {
        byRun.set(job.parentRunId, [...(byRun.get(job.parentRunId) ?? []), job]);
      } else rest.push(job);
    }
    return { byRun, rest };
  }, [spawned, view.messages]);
  const activeTraced = stepRun !== null && tracedRuns.has(stepRun.id);
  // The run has no message yet: its steps sit at the end until the reply begins below them.
  const activeAnchored =
    stepRun !== null && view.messages.some((m) => m.runId === stepRun.id && m.role === "agent");
  const showSteps = !activeTraced && (stepRun !== null || sentAt !== null);
  const incognitoThread = view.thread?.thread.kind === "incognito";
  // A failed run says so where its reply would have been (#539).
  const failures = useMemo(
    () => failureAnchors(view.messages, view.failedRuns),
    [view.messages, view.failedRuns],
  );

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

  // Bottom anchoring and the jump pill (motion.md §4.6); the floating stack's height pads the
  // transcript so the last message and any focused control clear the glass (WCAG 2.4.11).
  const viewportRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const stackHeight = useElementHeight(stackRef);
  const anchorVersion = `${display.length}:${display.at(-1)?.message.blocks.length ?? 0}:${display.at(-1)?.streamingText?.length ?? 0}:${working}:${steps.length}:${steps.at(-1)?.status ?? ""}`;
  const { away, jump } = useBottomAnchor(viewportRef, columnRef, anchorVersion);
  const empty = display.length === 0 && !view.loading;

  return (
    <DisclosureProvider
      {...(disclosure === undefined ? {} : { level: disclosure })}
      {...(onDisclosureChange === undefined ? {} : { onLevelChange: onDisclosureChange })}
    >
      <AssistantRuntimeProvider runtime={runtime}>
        <LayoutMotion>
          {/*
            #548: only the message viewport scrolls. `min-h-0` lets the root shrink below its
            content in a flex column; `flex-1` fills the column when the parent is flex,
            `h-full` when it is a block. The composer stack floats over the transcript's end
            (redesign-2026 §5.2), so the root is the positioning context.
          */}
          <ThreadPrimitive.Root className="relative flex h-full min-h-0 min-w-[min(100%,var(--chat-min-width))] flex-1 flex-col overflow-hidden bg-canvas">
            {offline ? <OfflineBanner state={connection} /> : null}
            <ThreadPrimitive.Viewport
              ref={viewportRef}
              autoScroll={false}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 [mask-image:linear-gradient(to_bottom,transparent_0,black_24px,black_calc(100%_-_24px),transparent_100%)]"
              style={{
                paddingBottom: stackHeight + 24,
                scrollPaddingBottom: stackHeight + 24,
              }}
              data-testid="chat-viewport"
              aria-label={t("chat.thread.conversation")}
              role="log"
            >
              {/*
                Short conversations sit just above the composer, as in a messaging app; long
                ones scroll. 680 px reading column (§3.7).
              */}
              <div
                ref={columnRef}
                className="mx-auto flex min-h-full w-full max-w-[680px] flex-col justify-end pt-6"
                data-testid="conversation-column"
              >
                {empty ? <EmptyThread /> : null}
                <TranscriptSkeleton loading={view.loading && display.length === 0} />
                <ThreadBlocksProvider index={blockIndex}>
                  <ThreadPrimitive.Messages>
                    {({ message }) => {
                      const [d] = getExternalStoreMessages<DisplayMessage>(message);
                      if (d === undefined) return null;
                      const m = d.message;
                      const prev = display[display.indexOf(d) - 1]?.message;
                      const next = display[display.indexOf(d) + 1]?.message;
                      // The run's specialists follow its last message.
                      const spawns =
                        m.runId != null && next?.runId !== m.runId
                          ? spawnsByRun.byRun.get(m.runId)
                          : undefined;
                      const lead = m.blocks[0];
                      const fromTask =
                        m.role === "agent" && m.runId === null && lead?.type === "task"
                          ? (tasks[lead.taskId] ?? null)
                          : null;
                      const failed = failures.get(m.id) ?? [];
                      // The run's steps sit once, above its first agent message (§3.2's anchor).
                      const runAnchor =
                        m.role === "agent" &&
                        m.runId != null &&
                        (prev?.runId !== m.runId || prev?.role !== "agent") &&
                        (tracedRuns.has(m.runId) ||
                          m.runId === stepRun?.id ||
                          m.blocks.some((b) => b.type === "tool_call" || b.type === "approval"));
                      return (
                        <>
                          {runAnchor && m.runId ? (
                            <RunTrace
                              runId={m.runId}
                              incognito={incognitoThread}
                              onStop={() => void view.cancel()}
                              {...(now === undefined ? {} : { now })}
                            />
                          ) : null}
                          <MessageView
                            message={m}
                            streamingText={d.streamingText}
                            quoted={
                              m.replyToMessageId ? (byId.get(m.replyToMessageId) ?? null) : null
                            }
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
                          {failed.map((run) => (
                            <RunFailure key={run.id} run={run} />
                          ))}
                          {spawns ? (
                            <SpecialistSpawns jobs={spawns} roles={specialistRoles} />
                          ) : null}
                        </>
                      );
                    }}
                  </ThreadPrimitive.Messages>
                </ThreadBlocksProvider>
                {stepRun && !activeAnchored ? (
                  <RunTrace
                    runId={stepRun.id}
                    incognito={incognitoThread}
                    onStop={() => void view.cancel()}
                    {...(now === undefined ? {} : { now })}
                  />
                ) : null}
                <SpecialistSpawns jobs={spawnsByRun.rest} roles={specialistRoles} />
                {showSteps ? (
                  <RunStepLog
                    persona={persona.name}
                    run={stepRun}
                    steps={steps}
                    {...(now === undefined ? {} : { now })}
                  />
                ) : null}
              </div>
            </ThreadPrimitive.Viewport>
            <div
              ref={stackRef}
              className="pointer-events-none absolute inset-x-0 bottom-0 px-6 pb-4"
              data-testid="composer-stack"
            >
              <div className="pointer-events-auto mx-auto flex w-full max-w-[680px] flex-col gap-2">
                <Presence>{away ? <JumpToLatest key="jump" onJump={jump} /> : null}</Presence>
                <ComposerPrefill />
                {empty ? <ComposerSuggestions /> : null}
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
                <VoiceComposer
                  threadId={threadId}
                  persona={persona.name}
                  running={view.running}
                  disabled={offline}
                  quoting={quoting}
                  onClearQuote={() => setQuoting(null)}
                  {...(askContext
                    ? {
                        context: {
                          title: askContext.title,
                          source: askContext.source,
                          onRemove: clearAskContext,
                        },
                      }
                    : {})}
                  mode={mode}
                  onStop={() => void view.cancel()}
                  {...(attachments.attach ? { attach: attachments.attach } : {})}
                  sendBlocked={attachments.uploading}
                  {...(onDictate ? { onDictate } : {})}
                />
              </div>
            </div>
          </ThreadPrimitive.Root>
        </LayoutMotion>
      </AssistantRuntimeProvider>
    </DisclosureProvider>
  );
}
