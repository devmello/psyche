import {
  appendMessage,
  claimWriter,
  createRun,
  enqueueMessage,
  finishRun,
  getMessage,
  getRun,
  getThread,
  listMessagesPage,
  listQueue,
  releaseWriter,
  removeQueued,
  takeNextQueued,
  threadsWithQueuedMessages,
  updateRun,
  upsertToolCall,
} from "@psyche/db";
import {
  type AgentEvent,
  type Block,
  type EventName,
  type EventPayload,
  type Message,
  type MethodResult,
  type Provenance,
  PsycheError,
  type QueueMode,
  type Requester,
  type Run,
  type RunStatus,
  type TaintSource,
  type Thread,
  type VoiceTurnOptions,
} from "@psyche/protocol";
import type { GatewayContext } from "../context.ts";

type SendResult = MethodResult<"chat.send">;

/** Model ref recorded on runs until S03's router picks one per turn. */
export const DEFAULT_MODEL_REF = "router/auto";

export interface SendInput {
  threadId: string;
  content: string;
  attachments?: string[];
  mode?: QueueMode;
  deviceId: string;
  /** Quote-reply (E5): a message of the same thread this one answers. */
  replyToMessageId?: string | null;
  /**
   * Who sent the message when it came through a channel (S10 `RouteContext`; security §9). The
   * loop and the broker decide the turn's calls as this person's. Absent for the owner's own
   * devices. Not kept for durable follow-ups (`chat_queue`), which only paired devices enqueue.
   */
  requester?: Requester;
  /**
   * `agent` when another thread's agent sent it (E12 cross-thread awareness); the transcript keeps
   * that provenance, including through the follow-up queue. Default `owner`.
   */
  provenance?: "owner" | "agent";
  /** The sending thread, for `agent` messages. */
  fromThreadId?: string;
  /**
   * Untrusted content inside `content` (forwarded or quoted third-party text in an owner's
   * channel message, #275): the turn starts tainted with these sources. Not kept for queued
   * follow-ups; channels send only to an idle thread.
   */
  taintSources?: TaintSource[];
  /**
   * A spoken turn from a voice conversation (docs/voice/voice-mode-2026.md §4.2): the message is
   * stored with `via: "voice"` and the turn starts with `StartTurnInput.voice`. Not kept for
   * queued follow-ups (`chat_queue`); the conversation sends an `interrupt` instead.
   */
  voice?: VoiceTurnOptions;
}

type Emit = <E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string) => void;

/** Callbacks a transactional handler passes in so events go out only after commit. */
export interface TxHooks {
  emit: Emit;
  afterCommit(fn: () => void): void;
}

interface ActiveTurn {
  runId: string;
  abort: AbortController;
  /** Set once the controller stopped listening to this run (cancelled, superseded, crashed). */
  detached: boolean;
  done: Promise<void>;
}

/** A message the agent is streaming, committed at its boundary. */
interface PendingMessage {
  id: string;
  blocks: Block[];
  /** Index of the trailing text block that deltas append to, or -1. */
  textIndex: number;
}

/**
 * The turn input for `chat.greet` (#555). Not stored in the transcript: the owner sees only the
 * agent's reply. Fixed text, so no client can speak to the agent through it.
 */
export const GREETING_PROMPT =
  "[Psyche: the owner just finished setting you up and opened this chat for the first time. " +
  "Write your first message: a short, warm hello in your own voice. Mention what you can already " +
  "reach (the accounts and tools you have) and one or two things you could help with now. If " +
  "BOOTSTRAP.md is in your context, follow it. Do not call tools that change anything.]";

/** How long `chat.cancel` waits for the agent to wind down before force-finishing the run. */
const CANCEL_GRACE_MS = 2_000;

/** What the agent reads for a quote-reply: the quoted message, then the new message. */
export interface Quote {
  messageId: string;
  role: Message["role"];
  text: string;
}

const QUOTE_MAX_CHARS = 280;

/** The quoted message's text, whitespace collapsed and cut to `QUOTE_MAX_CHARS`. */
export function quoteText(message: Pick<Message, "blocks">): string {
  const text = message.blocks
    .map((b) => (b.type === "text" ? b.md : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > QUOTE_MAX_CHARS ? `${text.slice(0, QUOTE_MAX_CHARS - 1)}…` : text;
}

/**
 * The turn text with the quote ahead of it (feature E5: "replies carry a quote reference the
 * agent sees"). The quoted text is data the user chose to point at, labelled as such.
 */
export function withQuote(quote: Quote | undefined, content: string): string {
  if (quote === undefined) return content;
  const whose =
    quote.role === "user"
      ? "the user's earlier message"
      : quote.role === "agent"
        ? "your earlier message"
        : `an earlier ${quote.role} message`;
  return `[Replying to ${whose} ${quote.messageId}]\n> ${quote.text}\n\n${content}`;
}

function userBlocks(content: string, attachments: readonly string[]): Block[] {
  return [
    { type: "text", md: content },
    ...attachments.map((id): Block => ({ type: "file", libraryItemId: id })),
  ];
}

/**
 * A channel sender who is not the owner speaks as data, never as the owner (security §3.6, §9):
 * their words go into the transcript as `untrusted`, so history, exports and other threads'
 * readers never pass them off as the owner's.
 */
function messageProvenance(requester: Requester | undefined): Provenance {
  return requester === undefined || requester.role === "owner" ? "owner" : "untrusted";
}

/**
 * Session controller (architecture §4.2 steps 2, 5, 6). Serializes turns per thread with the
 * transcript writer guard as the source of truth: `threads.active_writer_run_id` names the one
 * run that may append, and every append states the writer it expects. Messages sent mid-turn are
 * queued by mode: `followUp` (durable queue, runs after the turn settles), `steer` (recorded and
 * passed to `AgentLoop.steer`) or `interrupt` (cancels the run and starts a new one; the
 * superseded run can no longer commit). Cancellation revokes the run's tool authority through the
 * Permission Broker.
 */
export class SessionController {
  readonly #ctx: GatewayContext;
  readonly #active = new Map<string, ActiveTurn>();
  /** Runs whose input carries untrusted content (#275), until their turn starts. */
  readonly #inputTaint = new Map<string, TaintSource[]>();
  #stopping = false;
  /** Threads being deleted: no new turns, no queue drain. */
  readonly #closing = new Set<string>();

  constructor(ctx: GatewayContext) {
    this.#ctx = ctx;
  }

  activeRunId(threadId: string): string | null {
    return getThread(this.#ctx.db, threadId)?.activeWriterRunId ?? null;
  }

  /** Runs inside the request's transaction. */
  send(input: SendInput, hooks: TxHooks): SendResult {
    const { db } = this.#ctx;
    const thread = getThread(db, input.threadId);
    if (!thread || this.#closing.has(thread.id)) {
      throw new PsycheError("not_found", `thread ${input.threadId} not found`);
    }
    const attachments = input.attachments ?? [];
    const quote = this.#quote(thread.id, input.replyToMessageId ?? null);
    const active = thread.activeWriterRunId ?? null;
    if (active === null) {
      const { messageId, run } = this.#admit(
        thread,
        input.content,
        attachments,
        null,
        hooks,
        undefined,
        input.requester,
        input.provenance,
        quote,
        input.voice,
      );
      this.#noteTaint(run.id, input.taintSources);
      return { messageId, runId: run.id, queued: false };
    }
    const mode = input.mode ?? "followUp";
    if (mode === "followUp") {
      const item = enqueueMessage(db, {
        threadId: thread.id,
        content: input.content,
        attachments,
        // An agent-sent follow-up has no device (`deviceId` is empty).
        deviceId: input.deviceId === "" ? null : input.deviceId,
        provenance: input.provenance ?? "owner",
        fromThreadId: input.fromThreadId ?? null,
      });
      this.#bump();
      hooks.emit(
        "chat.queue.updated",
        { threadId: thread.id, items: listQueue(db, thread.id) },
        thread.id,
      );
      return { messageId: item.messageId, runId: null, queued: true };
    }
    if (mode === "steer") {
      // Recorded where it happened, under the active run's writer; the agent picks it up between
      // tool calls (feature E3: steering interrupts within one tool call).
      const message = appendMessage(
        db,
        {
          threadId: thread.id,
          role: "user",
          blocks: userBlocks(input.content, attachments),
          // An agent-sent cross-thread message stays `agent`; anything else is the sender's (§3.6).
          provenance: input.provenance === "agent" ? "agent" : messageProvenance(input.requester),
          replyToMessageId: quote?.messageId ?? null,
          runId: active,
          ...(input.voice === undefined ? {} : { via: "voice" as const }),
        },
        { expectedWriterRunId: active },
      );
      this.#bump();
      hooks.emit("chat.message", { message }, thread.id);
      hooks.afterCommit(() => {
        this.#ctx.agent
          .steer(active, withQuote(quote, input.content))
          .catch((err) => this.#warn("steer failed", err));
      });
      return { messageId: message.id, runId: active, queued: true };
    }
    // interrupt: cancel the active run and start a new one that supersedes it as the writer.
    const old = finishRun(db, active, { status: "cancelled", error: "interrupted" });
    hooks.emit("run.updated", { run: old }, thread.id);
    // Registered before #admit's start, so the old turn is detached and aborted first.
    hooks.afterCommit(() => this.#stopRun(thread.id, active, "interrupted"));
    const { messageId, run } = this.#admit(
      thread,
      input.content,
      attachments,
      active,
      hooks,
      undefined,
      input.requester,
      input.provenance,
      quote,
      input.voice,
    );
    this.#noteTaint(run.id, input.taintSources);
    return { messageId, runId: run.id, queued: false };
  }

  /** Taint the input itself carries, picked up when the run's turn starts. */
  #noteTaint(runId: string, sources: TaintSource[] | undefined): void {
    if (sources !== undefined && sources.length > 0) this.#inputTaint.set(runId, sources);
  }

  /** The quoted message of a reply, which must belong to the same thread. */
  #quote(threadId: string, replyToMessageId: string | null): Quote | undefined {
    if (replyToMessageId === null) return undefined;
    const quoted = getMessage(this.#ctx.db, replyToMessageId);
    if (quoted === undefined || quoted.threadId !== threadId) {
      throw new PsycheError(
        "invalid_params",
        "replyToMessageId must name a message of the same thread",
      );
    }
    return { messageId: quoted.id, role: quoted.role, text: quoteText(quoted) };
  }

  /** Creates the run, claims the writer, records the user message, starts the turn after commit. */
  #admit(
    thread: Thread,
    content: string,
    attachments: readonly string[],
    supersedes: string | null,
    hooks: TxHooks,
    messageId?: string,
    requester?: Requester,
    provenance: "owner" | "agent" = "owner",
    quote?: Quote,
    voice?: VoiceTurnOptions,
  ): { messageId: string; run: Run } {
    const via = voice === undefined ? {} : { via: "voice" as const };
    const { db } = this.#ctx;
    const agentContent = withQuote(quote, content);
    if (supersedes === null) {
      // The user message goes in before the run owns the transcript.
      const message = appendMessage(
        db,
        {
          ...(messageId ? { id: messageId } : {}),
          threadId: thread.id,
          role: "user",
          blocks: userBlocks(content, attachments),
          provenance: provenance === "agent" ? "agent" : messageProvenance(requester),
          replyToMessageId: quote?.messageId ?? null,
          ...via,
        },
        { expectedWriterRunId: null },
      );
      hooks.emit("chat.message", { message }, thread.id);
      const run = createRun(db, {
        threadId: thread.id,
        modelRef: thread.modelRef ?? DEFAULT_MODEL_REF,
        kind: "chat",
        origin: requester === undefined ? "owner" : "channel",
      });
      claimWriter(db, thread.id, run.id);
      this.#bump();
      hooks.emit("run.updated", { run }, thread.id);
      hooks.afterCommit(() =>
        this.#startTurn(thread, run.id, agentContent, attachments, requester, voice),
      );
      return { messageId: message.id, run };
    }
    const run = createRun(db, {
      threadId: thread.id,
      modelRef: thread.modelRef ?? DEFAULT_MODEL_REF,
      kind: "chat",
      origin: requester === undefined ? "owner" : "channel",
    });
    claimWriter(db, thread.id, run.id);
    const message = appendMessage(
      db,
      {
        threadId: thread.id,
        role: "user",
        blocks: userBlocks(content, attachments),
        provenance: provenance === "agent" ? "agent" : messageProvenance(requester),
        replyToMessageId: quote?.messageId ?? null,
        runId: run.id,
        ...via,
      },
      { expectedWriterRunId: run.id },
    );
    this.#bump();
    hooks.emit("chat.message", { message }, thread.id);
    hooks.emit("run.updated", { run }, thread.id);
    hooks.afterCommit(() =>
      this.#startTurn(thread, run.id, agentContent, attachments, requester, voice),
    );
    return { messageId: message.id, run };
  }

  /** Removes a queued follow-up (transactional). */
  removeQueued(threadId: string, messageId: string, hooks: TxHooks): boolean {
    const { db } = this.#ctx;
    const removed = removeQueued(db, threadId, messageId);
    if (removed) {
      this.#bump();
      hooks.emit("chat.queue.updated", { threadId, items: listQueue(db, threadId) }, threadId);
    }
    return removed;
  }

  /**
   * Cancels the thread's active run (or `runId` when it is the active one). Resolves once the run
   * is finished; returns whether anything was cancelled.
   */
  async cancel(threadId: string, runId?: string, opts: { drain?: boolean } = {}): Promise<boolean> {
    const { db, bus } = this.#ctx;
    const active = this.activeRunId(threadId);
    if (active === null || (runId !== undefined && runId !== active)) return false;
    const turn = this.#active.get(threadId);
    await this.#revoke(active, "cancelled by the user");
    turn?.abort.abort();
    if (turn && turn.runId === active) {
      // Give the agent a moment to end with outcome "cancelled" and commit what it has.
      await Promise.race([turn.done, new Promise((r) => setTimeout(r, CANCEL_GRACE_MS).unref())]);
    }
    if (this.activeRunId(threadId) === active) {
      if (turn && turn.runId === active) turn.detached = true;
      const run = db.sqlite.transaction(() => {
        const finished = finishRun(db, active, { status: "cancelled", error: "cancelled" });
        releaseWriter(db, threadId, active);
        this.#bump();
        return finished;
      })();
      bus.publish("run.updated", { run }, threadId);
      if (opts.drain !== false) this.#drain(threadId);
    }
    return true;
  }

  /** Stops listening to a superseded run and revokes its authority. */
  #stopRun(threadId: string, runId: string, reason: string): void {
    const turn = this.#active.get(threadId);
    if (turn && turn.runId === runId) {
      turn.detached = true;
      turn.abort.abort();
    }
    this.#revoke(runId, reason).catch((err) => this.#warn("revoke failed", err));
  }

  async #revoke(runId: string, reason: string): Promise<void> {
    await Promise.allSettled([
      this.#ctx.agent.cancel(runId, reason),
      this.#ctx.broker.revokeRunAuthority(runId),
    ]);
  }

  /**
   * Deletes a thread safely: stops admitting turns and draining its queue, cancels the active
   * run (revoking its authority), then runs `remove` in a transaction with no writer left.
   */
  async closeThread(threadId: string, remove: () => void): Promise<void> {
    this.#closing.add(threadId);
    try {
      await this.cancel(threadId, undefined, { drain: false });
      const { db } = this.#ctx;
      db.sqlite.transaction(() => {
        const writer = this.activeRunId(threadId);
        if (writer !== null) {
          finishRun(db, writer, { status: "cancelled", error: "thread deleted" });
          releaseWriter(db, threadId, writer);
        }
        remove();
      })();
      const turn = this.#active.get(threadId);
      if (turn) this.#stopRun(threadId, turn.runId, "thread deleted");
    } finally {
      this.#closing.delete(threadId);
    }
  }

  /**
   * The agent's first message in an empty thread (#555; UI design §4.13): a turn with no user
   * message, from a fixed prompt the Gateway owns (never client text). BOOTSTRAP.md, injected
   * while it exists, carries the first-run ritual. A thread with any message or a run is left
   * alone, so a repeat call (a second window, a reload) never greets twice.
   */
  greet(threadId: string, hooks: TxHooks): { started: boolean; runId: string | null } {
    const { db } = this.#ctx;
    const thread = getThread(db, threadId);
    if (!thread || this.#closing.has(thread.id)) {
      throw new PsycheError("not_found", `thread ${threadId} not found`);
    }
    if ((thread.activeWriterRunId ?? null) !== null) return { started: false, runId: null };
    if (listMessagesPage(db, thread.id, { limit: 1 }).messages.length > 0) {
      return { started: false, runId: null };
    }
    const run = createRun(db, {
      threadId: thread.id,
      modelRef: thread.modelRef ?? DEFAULT_MODEL_REF,
      kind: "chat",
      origin: "owner",
    });
    claimWriter(db, thread.id, run.id);
    this.#bump();
    hooks.emit("run.updated", { run }, thread.id);
    hooks.afterCommit(() => this.#startTurn(thread, run.id, GREETING_PROMPT, []));
    return { started: true, runId: run.id };
  }

  /**
   * E12 cross-thread awareness: a message from another thread's agent. It never interrupts or
   * steers: it runs now if the thread is idle, or queues as a follow-up, recorded as `agent`.
   */
  sendFromAgent(input: { threadId: string; fromThreadId: string; content: string }): SendResult {
    const { db, bus } = this.#ctx;
    const events: Array<() => void> = [];
    const after: Array<() => void> = [];
    const hooks: TxHooks = {
      emit: (event, payload, tid) => events.push(() => bus.publish(event, payload, tid)),
      afterCommit: (fn) => after.push(fn),
    };
    const result = db.sqlite.transaction(() =>
      this.send(
        {
          threadId: input.threadId,
          content: input.content,
          mode: "followUp",
          deviceId: "",
          provenance: "agent",
          fromThreadId: input.fromThreadId,
        },
        hooks,
      ),
    )();
    for (const publish of events) publish();
    for (const fn of after) fn();
    return result;
  }

  /** Starts queued follow-ups for every thread that has some (boot). */
  drainAll(): void {
    for (const threadId of threadsWithQueuedMessages(this.#ctx.db)) this.#drain(threadId);
  }

  /** If the thread is idle, starts the next queued follow-up. */
  #drain(threadId: string): void {
    if (this.#stopping || this.#closing.has(threadId)) return;
    const { db, bus } = this.#ctx;
    const thread = getThread(db, threadId);
    if (!thread || (thread.activeWriterRunId ?? null) !== null) return;
    const events: Array<() => void> = [];
    const after: Array<() => void> = [];
    const hooks: TxHooks = {
      emit: (event, payload, tid) => events.push(() => bus.publish(event, payload, tid)),
      afterCommit: (fn) => after.push(fn),
    };
    const started = db.sqlite.transaction(() => {
      const next = takeNextQueued(db, threadId);
      if (!next) return false;
      this.#admit(
        thread,
        next.content,
        next.attachments,
        null,
        hooks,
        next.messageId,
        undefined,
        next.provenance,
      );
      hooks.emit("chat.queue.updated", { threadId, items: listQueue(db, threadId) }, threadId);
      return true;
    })();
    if (!started) return;
    for (const publish of events) publish();
    for (const fn of after) fn();
  }

  #startTurn(
    thread: Thread,
    runId: string,
    content: string,
    attachments: readonly string[],
    requester?: Requester,
    voice?: VoiceTurnOptions,
  ): void {
    if (this.#stopping || this.#closing.has(thread.id)) return;
    const abort = new AbortController();
    const turn: ActiveTurn = { runId, abort, detached: false, done: Promise.resolve() };
    this.#active.set(thread.id, turn);
    turn.done = this.#runTurn(thread, turn, content, attachments, requester, voice)
      .catch((err) => this.#warn("turn crashed", err))
      .finally(() => {
        if (this.#active.get(thread.id) === turn) this.#active.delete(thread.id);
        if (!turn.detached || this.activeRunId(thread.id) === null) this.#drain(thread.id);
      });
  }

  async #runTurn(
    thread: Thread,
    turn: ActiveTurn,
    content: string,
    attachments: readonly string[],
    requester?: Requester,
    voice?: VoiceTurnOptions,
  ): Promise<void> {
    const { db, bus, agent } = this.#ctx;
    const { runId } = turn;
    const threadId = thread.id;
    const pending = new Map<string, PendingMessage>();
    const order: string[] = [];
    let currentKey: string | undefined;
    /** Agent message ids → transcript ids (an agent id that already exists gets a fresh one). */
    const idFor = (agentMessageId: string): PendingMessage => {
      let msg = pending.get(agentMessageId);
      if (!msg) {
        const id = getMessage(db, agentMessageId) ? db.newId() : agentMessageId;
        msg = { id, blocks: [], textIndex: -1 };
        pending.set(agentMessageId, msg);
        order.push(agentMessageId);
      }
      currentKey = agentMessageId;
      return msg;
    };
    /** The message streaming now; tool calls and cards attach to it (or start one). */
    const current = (fallbackKey: string): PendingMessage =>
      idFor(currentKey !== undefined && pending.has(currentKey) ? currentKey : fallbackKey);
    let outcome: { status: RunStatus; error: string | null } = {
      status: "failed",
      error: "no end event",
    };

    /** Writes one committed message; `false` when the run lost the transcript. */
    const commit = (msg: PendingMessage): boolean => {
      if (msg.blocks.length === 0) return true;
      try {
        const message: Message = db.sqlite.transaction(() => {
          const m = appendMessage(
            db,
            { id: msg.id, threadId, role: "agent", blocks: msg.blocks, provenance: "agent", runId },
            { expectedWriterRunId: runId },
          );
          const toolIds = msg.blocks.flatMap((b) => (b.type === "tool_call" ? [b.toolCallId] : []));
          for (const id of toolIds) {
            db.sqlite
              .prepare("UPDATE tool_calls SET message_id = ? WHERE id = ? AND run_id = ?")
              .run(m.id, id, runId);
          }
          this.#bump();
          return m;
        })();
        bus.publish("chat.message", { message }, threadId);
        return true;
      } catch (err) {
        if (PsycheError.from(err).code === "conflict") {
          turn.detached = true; // superseded: the writer guard rejected a stale write
          return false;
        }
        throw err;
      }
    };
    const flushBefore = (agentMessageId: string) => {
      // Messages stream one after another: a new id means the earlier ones are complete.
      while (order.length > 0 && order[0] !== agentMessageId) {
        const first = order.shift() as string;
        const msg = pending.get(first);
        pending.delete(first);
        if (msg && !commit(msg)) return;
      }
    };

    try {
      const inputTaint = this.#inputTaint.get(runId);
      this.#inputTaint.delete(runId);
      const stream = agent.startTurn({
        threadId,
        runId,
        input: {
          text: content,
          ...(attachments.length > 0
            ? { attachments: attachments.map((libraryItemId) => ({ libraryItemId })) }
            : {}),
        },
        mode: "attended",
        permissionMode: thread.permissionMode,
        signal: turn.abort.signal,
        ...(requester === undefined ? {} : { requester }),
        ...(inputTaint === undefined ? {} : { taintSources: inputTaint }),
        ...(voice === undefined ? {} : { voice }),
      });
      for await (const event of stream) {
        if (turn.detached || this.activeRunId(threadId) !== runId) {
          turn.detached = true;
          break;
        }
        if (event.runId !== runId) continue;
        if (event.type === "end") {
          outcome = endStatus(event);
          this.#ctx.runTrace.end(runId, event.outcome);
          break;
        }
        this.#apply(event, { threadId, runId, idFor, current, flushBefore });
      }
    } catch (err) {
      outcome = { status: "failed", error: PsycheError.from(err).message };
      this.#ctx.runTrace.end(runId, "failed");
    }
    if (turn.detached) {
      this.#ctx.runTrace.end(runId, "cancelled");
      return;
    }

    for (const agentMessageId of order) {
      const msg = pending.get(agentMessageId);
      if (msg && !commit(msg)) return;
    }
    if (turn.detached || this.activeRunId(threadId) !== runId) return;
    const run = db.sqlite.transaction(() => {
      const finished =
        outcome.status === "done" || outcome.status === "failed" || outcome.status === "cancelled"
          ? finishRun(db, runId, { status: outcome.status, error: outcome.error })
          : updateRun(db, runId, { status: outcome.status });
      // Awaiting runs release the transcript too: the next message starts a new turn, and the
      // task engine resumes the suspended work (S02/S04).
      releaseWriter(db, threadId, runId);
      this.#bump();
      return finished;
    })();
    bus.publish("run.updated", { run }, threadId);
    if (outcome.status === "cancelled") await this.#revoke(runId, "cancelled");
  }

  #apply(
    event: Exclude<AgentEvent, { type: "end" }>,
    t: {
      threadId: string;
      runId: string;
      idFor: (agentMessageId: string) => PendingMessage;
      current: (fallbackKey: string) => PendingMessage;
      flushBefore: (agentMessageId: string) => void;
    },
  ): void {
    const { db, bus } = this.#ctx;
    const { threadId, runId } = t;
    // The run trace sees every event first (run trace §4.2), so a tool call carries its step.
    const stepId = this.#traceStep(runId, threadId, event);
    switch (event.type) {
      case "run.status": {
        if (event.status === "done" || event.status === "failed" || event.status === "cancelled")
          return;
        const run = updateRun(db, runId, { status: event.status });
        this.#bump();
        bus.publish("run.updated", { run }, threadId);
        return;
      }
      case "chat.delta": {
        t.flushBefore(event.messageId);
        const msg = t.idFor(event.messageId);
        const last = msg.blocks[msg.textIndex];
        if (
          msg.textIndex >= 0 &&
          last?.type === "text" &&
          msg.textIndex === msg.blocks.length - 1
        ) {
          last.md += event.delta;
        } else {
          msg.blocks.push({ type: "text", md: event.delta });
          msg.textIndex = msg.blocks.length - 1;
        }
        bus.publish(
          "chat.delta",
          { threadId, messageId: msg.id, runId, delta: event.delta },
          threadId,
        );
        return;
      }
      case "reasoning": {
        // Transient step-log text (model output): published, never added to the message.
        bus.publish(
          "chat.reasoning",
          {
            threadId,
            runId,
            stepId: event.stepId,
            ...(event.delta === undefined ? {} : { delta: event.delta }),
            ...(event.summary === undefined ? {} : { summary: event.summary }),
            ...(event.done === undefined ? {} : { done: event.done }),
          },
          threadId,
        );
        return;
      }
      case "block": {
        t.flushBefore(event.messageId);
        const msg = t.idFor(event.messageId);
        msg.blocks.push(event.block);
        bus.publish("chat.block", { threadId, messageId: msg.id, block: event.block }, threadId);
        return;
      }
      case "tool_call": {
        const d = event.details ?? {};
        const toolCall = upsertToolCall(db, {
          id: event.toolCallId,
          runId,
          tool: event.tool,
          status: event.status,
          ...d,
          ...(stepId === undefined ? {} : { stepId }),
        });
        this.#bump();
        // The transcript shows the call in the message currently streaming (or a new one).
        const current = t.current(`tool_${event.toolCallId}`);
        const block: Block = {
          type: "tool_call",
          toolCallId: event.toolCallId,
          tool: event.tool,
          status: event.status,
          level1: event.level1 ?? event.tool,
        };
        const at = current.blocks.findIndex(
          (b) => b.type === "tool_call" && b.toolCallId === event.toolCallId,
        );
        if (at >= 0) current.blocks[at] = block;
        else current.blocks.push(block);
        current.textIndex = -1;
        bus.publish("tool_call.updated", { toolCall }, threadId);
        return;
      }
      case "approval_requested": {
        const msg = t.current(`approval_${event.approval.id}`);
        msg.blocks.push({ type: "approval", approvalId: event.approval.id });
        msg.textIndex = -1;
        const run = updateRun(db, runId, { status: "awaiting_approval" });
        this.#bump();
        bus.publish("approval.created", { approval: event.approval }, threadId);
        bus.publish("run.updated", { run }, threadId);
        return;
      }
      case "question": {
        const msg = t.current(`question_${event.inputRequest.id}`);
        msg.blocks.push({ type: "question", inputRequestId: event.inputRequest.id });
        msg.textIndex = -1;
        const run = updateRun(db, runId, { status: "awaiting_input" });
        this.#bump();
        bus.publish("question.created", { inputRequest: event.inputRequest }, threadId);
        bus.publish("run.updated", { run }, threadId);
        return;
      }
      case "usage": {
        const run = updateRun(db, runId, { usage: event.usage });
        this.#bump();
        bus.publish("run.updated", { run }, threadId);
        return;
      }
    }
  }

  #bump(): void {
    this.#ctx.bus.bumpStateVersion();
  }

  /** The step an event touched; a trace failure never fails the turn. */
  #traceStep(runId: string, threadId: string, event: AgentEvent): string | undefined {
    try {
      return this.#ctx.runTrace.apply(runId, threadId, event);
    } catch (err) {
      this.#warn("run trace write failed", err);
      return undefined;
    }
  }

  #warn(msg: string, err: unknown): void {
    const e = PsycheError.from(err);
    // Code only: agent and provider errors can echo prompt text (architecture §14).
    this.#ctx.log.log("warn", msg, { code: e.code });
  }

  /** Graceful shutdown: stop starting turns, abort running ones. Runs are recovered at boot. */
  async stop(): Promise<void> {
    this.#stopping = true;
    const turns = [...this.#active.values()];
    for (const turn of turns) {
      turn.detached = true;
      turn.abort.abort();
    }
    await Promise.race([
      Promise.allSettled(turns.map((t) => t.done)),
      new Promise((r) => setTimeout(r, CANCEL_GRACE_MS).unref()),
    ]);
  }

  /** For tests: resolves when no turn is running. */
  async idle(): Promise<void> {
    while (this.#active.size > 0) {
      await Promise.allSettled([...this.#active.values()].map((t) => t.done));
    }
  }

  runOf(runId: string): Run | undefined {
    return getRun(this.#ctx.db, runId);
  }
}

function endStatus(event: Extract<AgentEvent, { type: "end" }>): {
  status: RunStatus;
  error: string | null;
} {
  switch (event.outcome) {
    case "final":
    case "no_reply":
      return { status: "done", error: null };
    case "awaiting_approval":
      return { status: "awaiting_approval", error: null };
    case "awaiting_input":
      return { status: "awaiting_input", error: null };
    case "cancelled":
      return { status: "cancelled", error: event.error ?? "cancelled" };
    case "failed":
      return { status: "failed", error: event.error ?? "failed" };
  }
}
