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
import type { SearchDoc } from "./types.ts";

/** What the indexer needs from the index (`SqliteSearchIndex` implements it). */
export interface IndexWriter {
  index(doc: SearchDoc): Promise<void>;
  remove(id: string): Promise<void>;
  removeThread(threadId: string): Promise<number>;
  setFlag(targetId: string, flag: SearchFlag): Promise<void>;
  retitleThread(threadId: string, title: string, scopeKey: string): Promise<void>;
}

type ThreadInfo = Pick<Thread, "id" | "title" | "kind" | "personaOverlay" | "sessionKey">;

export interface SearchIndexerOptions {
  /** Loads a thread the indexer has not seen an event for yet (Gateway: the threads repo). */
  lookupThread?: (threadId: string) => Promise<ThreadInfo | undefined>;
  /** Display name / address of a message's sender for `from:` (channel peers, email senders). */
  senderOf?: (message: Message, thread: ThreadInfo | undefined) => string | undefined;
  /** Called with errors from event handling; indexing never throws into the event bus. */
  onError?: (error: unknown, event: string) => void;
}

/**
 * Incremental indexing from Gateway events (`src/events.ts` in `@psyche/protocol`):
 * `thread.updated`, `thread.deleted`, `chat.message`, `task.updated`, `task.action`,
 * `approval.created`, `receipt.created`, `feed.post`, `feed.updated`, `idea.updated`,
 * `goal.updated`. Library items and connector caches have no events yet: their owners call
 * `libraryDoc` / `connectorDoc` and `index()` directly. Feed in every event (`handle(name, payload)`); unknown events are ignored.
 * A thread that becomes incognito is removed with everything under it.
 */
export class SearchIndexer {
  #index: IndexWriter;
  #opts: SearchIndexerOptions;
  #threads = new Map<string, ThreadInfo>();
  #tasks = new Map<string, Pick<Task, "title" | "threadId">>();

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
    if (isIncognito(thread)) {
      await this.#index.removeThread(thread.id);
      return;
    }
    await this.#index.index(threadDoc(thread));
    if (
      prev !== undefined &&
      (prev.title !== thread.title || threadScope(prev) !== threadScope(thread))
    ) {
      await this.#index.retitleThread(thread.id, thread.title, threadScope(thread));
    }
  }

  async onMessage(message: Message): Promise<void> {
    const thread = await this.#thread(message.threadId);
    if (thread !== undefined && isIncognito(thread)) return;
    const sender = this.#opts.senderOf?.(message, thread);
    await this.#index.index(
      messageDoc(message, {
        ...(thread === undefined ? {} : { thread }),
        ...(sender === undefined ? {} : { sender }),
      }),
    );
    if (hasAttachment(message)) {
      await this.#index.setFlag(message.id, "attachment");
      await this.#index.setFlag(message.threadId, "attachment");
    }
  }

  async onTask(task: Task): Promise<void> {
    this.#tasks.set(task.id, { title: task.title, threadId: task.threadId });
    const thread = await this.#thread(task.threadId);
    if (thread !== undefined && isIncognito(thread)) return;
    await this.#index.index(taskDoc(task, thread));
  }

  async onTaskAction(action: TaskAction): Promise<void> {
    const task = this.#tasks.get(action.taskId);
    const thread = task === undefined ? undefined : await this.#thread(task.threadId);
    if (thread !== undefined && isIncognito(thread)) return;
    await this.#index.index(
      taskActionDoc(action, task, thread === undefined ? undefined : threadScope(thread)),
    );
  }

  async onApproval(approval: ApprovalRequest): Promise<void> {
    const { taskId, threadId } = approval.requestedBy;
    if (taskId != null) await this.#index.setFlag(taskId, "approval");
    if (threadId != null) await this.#index.setFlag(threadId, "approval");
  }

  async onReceipt(receipt: Receipt): Promise<void> {
    if (receipt.taskId != null) await this.#index.setFlag(receipt.taskId, "receipt");
  }

  async #thread(id: string): Promise<ThreadInfo | undefined> {
    const cached = this.#threads.get(id);
    if (cached !== undefined) return cached;
    const loaded = await this.#opts.lookupThread?.(id);
    if (loaded !== undefined) this.#threads.set(id, loaded);
    return loaded;
  }
}
