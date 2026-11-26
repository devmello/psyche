import type {
  ApprovalRequest,
  FeedPost,
  Goal,
  Idea,
  Message,
  Receipt,
  Task,
  TaskAction,
  Thread,
} from "@psyche/protocol";
import { isForkSessionKey } from "@psyche/protocol";
import {
  feedDoc,
  goalDoc,
  hasAttachment,
  ideaDoc,
  isIncognito,
  messageDoc,
  taskActionDoc,
  taskDoc,
  threadDoc,
  threadScope,
} from "./adapters.ts";
import type { SearchFlag } from "./query-parser.ts";
import type { MessageSender } from "./senders.ts";
import type { SearchDoc } from "./types.ts";

/** What the indexer needs from the index (`SqliteSearchIndex` implements it). */
export interface IndexWriter {
  index(doc: SearchDoc): Promise<void>;
  remove(id: string): Promise<void>;
  removeThread(threadId: string): Promise<number>;
  /** The messages indexed under a thread whose transcript was cleared; the thread stays. */
  removeThreadMessages(threadId: string): Promise<number>;
  setFlag(targetId: string, flag: SearchFlag): Promise<void>;
  retitleThread(threadId: string, title: string, scopeKey: string): Promise<void>;
}

type ThreadInfo = Pick<Thread, "id" | "title" | "kind" | "personaOverlay" | "sessionKey">;

export interface SearchIndexerOptions {
  /** Loads a thread the indexer has not seen an event for yet (Gateway: the threads repo). */
  lookupThread?: (threadId: string) => Promise<ThreadInfo | undefined>;
  /** Loads a task for a `task.action` that arrives before (or without) its `task.updated`. */
  lookupTask?: (
    taskId: string,
  ) => Promise<(Pick<Task, "title" | "threadId"> & Partial<Pick<Task, "createdFrom">>) | undefined>;
  /**
   * Whether a thread is one of a plan fork's hidden threads by origin (Gateway: a
   * `plan_fork_branches` row). Fork session keys (`fork-branch:`, `fork-digest:`) and fork tasks
   * (`createdFrom: "fork"`) are left out without it (fork-a-plan-2026 §2.3).
   */
  isForkThread?: (threadId: string) => boolean;
  /**
   * Who sent a message, for `from:` (Gateway: `messageSender`, with the owner's name from the
   * profile). Called for every chat message; undefined leaves the message without a sender.
   */
  senderOf?: (
    message: Message,
    thread: ThreadInfo | undefined,
  ) => MessageSender | undefined | Promise<MessageSender | undefined>;
  /** Called with errors from event handling; indexing never throws into the event bus. */
  onError?: (error: unknown, event: string) => void;
}

/**
 * Incremental indexing from Gateway events (`src/events.ts` in `@psyche/protocol`):
 * `thread.updated`, `thread.deleted`, `thread.cleared`, `chat.message`, `task.updated`, `task.action`,
 * `approval.created`, `receipt.created`, `feed.post`, `feed.updated`, `idea.updated`,
 * `goal.updated`. Library items and connector caches have no events yet: their owners call
 * `libraryDoc` / `connectorDoc` and `index()` directly. Feed in every event
 * (`handle(name, payload)`); unknown events are ignored. A thread that becomes incognito is
 * removed with everything under it; content of an unknown thread is skipped (fail closed).
 */
export class SearchIndexer {
  #index: IndexWriter;
  #opts: SearchIndexerOptions;
  #threads = new Map<string, ThreadInfo>();
  #tasks = new Map<string, Pick<Task, "title" | "threadId"> & { fork?: boolean }>();

  constructor(index: IndexWriter, options: SearchIndexerOptions = {}) {
    this.#index = index;
    this.#opts = options;
  }

  async handle(event: string, payload: unknown): Promise<void> {
    try {
      await this.#dispatch(event, payload as Record<string, unknown>);
    } catch (err) {
      if (this.#opts.onError === undefined) throw err;
      this.#opts.onError(err, event);
    }
  }

  async #dispatch(event: string, p: Record<string, unknown>): Promise<void> {
    switch (event) {
      case "thread.updated":
        return this.onThread(p.thread as Thread);
      case "chat.message":
        return this.onMessage(p.message as Message);
      case "task.updated":
        return this.onTask(p.task as Task);
      case "task.action":
        return this.onTaskAction(p.action as TaskAction);
      case "approval.created":
        return this.onApproval(p.approval as ApprovalRequest);
      case "receipt.created":
        return this.onReceipt(p.receipt as Receipt);
      case "thread.deleted":
        this.#threads.delete(p.threadId as string);
        await this.#index.removeThread(p.threadId as string);
        return;
      case "thread.cleared":
        await this.#index.removeThreadMessages(p.threadId as string);
        return;
      case "feed.post":
        return this.#index.index(feedDoc(p.post as FeedPost));
      case "feed.updated":
        for (const post of p.posts as FeedPost[]) await this.#index.index(feedDoc(post));
        return;
      case "idea.updated":
        return this.#index.index(ideaDoc(p.idea as Idea));
      case "goal.updated":
        return this.#index.index(goalDoc(p.goal as Goal));
      default:
        return;
    }
  }

  async onThread(thread: Thread): Promise<void> {
    const prev = this.#threads.get(thread.id);
    this.#threads.set(thread.id, thread);
    if (this.#hidden(thread)) {
      await this.#index.removeThread(thread.id);
      return;
    }
    await this.#index.index(threadDoc(thread));
    if (
      prev === undefined ||
      prev.title !== thread.title ||
      threadScope(prev) !== threadScope(thread)
    ) {
      await this.#index.retitleThread(thread.id, thread.title, threadScope(thread));
    }
  }

  /**
   * Messages, tasks and actions are indexed only when their thread is known: without it the
   * indexer cannot tell an incognito or designated-person thread from the owner's, so it fails
   * closed (configure `lookupThread` / `lookupTask` so nothing is lost).
   */
  async onMessage(message: Message): Promise<void> {
    const thread = await this.#thread(message.threadId);
    if (thread === undefined || this.#hidden(thread)) return;
    const sender = await this.#opts.senderOf?.(message, thread);
    await this.#index.index(
      messageDoc(message, {
        thread,
        ...(sender === undefined
          ? {}
          : { sender: sender.name, senderAliases: sender.aliases ?? [] }),
      }),
    );
    if (hasAttachment(message)) {
      await this.#index.setFlag(message.id, "attachment");
      await this.#index.setFlag(message.threadId, "attachment");
    }
  }

  async onTask(task: Task): Promise<void> {
    const fork = task.createdFrom === "fork";
    this.#tasks.set(task.id, { title: task.title, threadId: task.threadId, fork });
    // A fork task's goal can hold read excerpts (mail, Messages, Memory): never indexed.
    if (fork) return;
    const thread = await this.#thread(task.threadId);
    if (thread === undefined || this.#hidden(thread)) return;
    await this.#index.index(taskDoc(task, thread));
  }

  async onTaskAction(action: TaskAction): Promise<void> {
    const task = await this.#task(action.taskId);
    const thread = task === undefined ? undefined : await this.#thread(task.threadId);
    if (task === undefined || task.fork === true || thread === undefined || this.#hidden(thread))
      return;
    await this.#index.index(taskActionDoc(action, task, threadScope(thread)));
  }

  async onApproval(approval: ApprovalRequest): Promise<void> {
    const { taskId, threadId } = approval.requestedBy;
    if (taskId != null) await this.#index.setFlag(taskId, "approval");
    if (threadId != null) await this.#index.setFlag(threadId, "approval");
  }

  async onReceipt(receipt: Receipt): Promise<void> {
    if (receipt.taskId != null) await this.#index.setFlag(receipt.taskId, "receipt");
  }

  async #task(
    id: string,
  ): Promise<(Pick<Task, "title" | "threadId"> & { fork?: boolean }) | undefined> {
    const cached = this.#tasks.get(id);
    if (cached !== undefined) return cached;
    const loaded = await this.#opts.lookupTask?.(id);
    if (loaded === undefined) return undefined;
    const entry = {
      title: loaded.title,
      threadId: loaded.threadId,
      fork: loaded.createdFrom === "fork",
    };
    this.#tasks.set(id, entry);
    return entry;
  }

  /** Incognito, or a plan fork's hidden thread (by session key or by origin): never indexed. */
  #hidden(thread: ThreadInfo): boolean {
    return (
      isIncognito(thread) ||
      isForkSessionKey(thread.sessionKey) ||
      this.#opts.isForkThread?.(thread.id) === true
    );
  }

  async #thread(id: string): Promise<ThreadInfo | undefined> {
    const cached = this.#threads.get(id);
    if (cached !== undefined) return cached;
    const loaded = await this.#opts.lookupThread?.(id);
    if (loaded !== undefined) this.#threads.set(id, loaded);
    return loaded;
  }
}
