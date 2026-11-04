import { newIdempotencyKey } from "./client.ts";

/**
 * The `chat.send` outbox (remote-gateway design §4.5, mobile design §2.3): messages typed while the
 * connection to the Gateway is down wait here and go out, in order, once it is back. Each carries
 * the idempotency key it was queued under, and every attempt re-sends that same key, so a send
 * whose answer was lost with the connection is replayed by the Gateway rather than run twice:
 * the message is delivered exactly once. The queue is plain data over a key-value store, so the
 * desktop's remote window and the phone's web client share it.
 */

/** The slice of `chat.send`'s params the outbox keeps: text, where it goes and what it answers. */
export interface OutboxParams {
  threadId: string;
  content: string;
  replyToMessageId?: string;
}

export interface OutboxItem {
  /** The idempotency key every attempt sends. */
  key: string;
  params: OutboxParams;
  createdAt: string;
}

export interface OutboxStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Wire codes where waiting and trying again can work; any other answer is final. */
const TRANSIENT = new Set(["unavailable", "timeout", "rate_limited", "internal", "cancelled"]);

export interface FlushResult {
  sent: number;
  /** Messages the Gateway refused for good (the thread is gone, the content was invalid). */
  dropped: { item: OutboxItem; error: unknown }[];
  /** Stopped at a message that could not be sent yet; the rest still wait. */
  blocked: boolean;
}

export const OUTBOX_MAX_ITEMS = 50;

function isItem(v: unknown): v is OutboxItem {
  const x = v as Partial<OutboxItem> | null;
  const p = x?.params as Partial<OutboxParams> | undefined;
  return (
    typeof x?.key === "string" &&
    typeof x.createdAt === "string" &&
    typeof p?.threadId === "string" &&
    typeof p.content === "string"
  );
}

export class ChatOutbox {
  readonly #storage: OutboxStorage;
  readonly #storageKey: string;
  readonly #now: () => string;
  readonly #listeners = new Set<() => void>();
  #items: OutboxItem[];
  #flushing: Promise<FlushResult> | null = null;

  constructor(
    storage: OutboxStorage,
    options: { storageKey?: string; now?: () => string } = {},
  ) {
    this.#storage = storage;
    this.#storageKey = options.storageKey ?? "psyche.chat-outbox.v1";
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#items = this.#load();
  }

  #load(): OutboxItem[] {
    try {
      const raw = this.#storage.get(this.#storageKey);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isItem).slice(0, OUTBOX_MAX_ITEMS) : [];
    } catch {
      return [];
    }
  }

  #save(): void {
    try {
      this.#storage.set(this.#storageKey, JSON.stringify(this.#items));
    } catch {
      // A full or blocked store only costs persistence across a restart, not this session.
    }
    for (const l of this.#listeners) l();
  }

  /** What waits, oldest first; a snapshot, never the live array. */
  items(threadId?: string): readonly OutboxItem[] {
    const all = this.#items;
    return threadId === undefined ? [...all] : all.filter((i) => i.params.threadId === threadId);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Queues a message under a fresh idempotency key. Throws when the outbox is full. */
  enqueue(params: OutboxParams): OutboxItem {
    if (this.#items.length >= OUTBOX_MAX_ITEMS) throw new Error("outbox full");
    const item: OutboxItem = {
      key: `outbox:${newIdempotencyKey()}`,
      params: {
        threadId: params.threadId,
        content: params.content,
        ...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {}),
      },
      createdAt: this.#now(),
    };
    this.#items = [...this.#items, item];
    this.#save();
    return item;
  }

  /** Removes a waiting message (the owner changed their mind); `false` if it already went out. */
  remove(key: string): boolean {
    const next = this.#items.filter((i) => i.key !== key);
    if (next.length === this.#items.length) return false;
    this.#items = next;
    this.#save();
    return true;
  }

  /**
   * Sends everything that waits, oldest first, one at a time. A message leaves the queue only after
   * its send settles: a failure that waiting can fix stops the run and keeps it (and everything
   * behind it, so order holds); a final refusal drops that message and goes on. Two calls at once
   * share one run, so nothing is sent twice by two triggers.
   */
  flush(send: (item: OutboxItem) => Promise<unknown>): Promise<FlushResult> {
    if (this.#flushing !== null) return this.#flushing;
    const run = (async (): Promise<FlushResult> => {
      const result: FlushResult = { sent: 0, dropped: [], blocked: false };
      for (;;) {
        const item = this.#items[0];
        if (item === undefined) return result;
        try {
          await send(item);
          result.sent += 1;
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (typeof code !== "string" || TRANSIENT.has(code)) {
            result.blocked = true;
            return result;
          }
          result.dropped.push({ item, error });
        }
        // The owner may have removed it while it was in flight; either way it is done.
        this.#items = this.#items.filter((i) => i.key !== item.key);
        this.#save();
      }
    })().finally(() => {
      this.#flushing = null;
    });
    this.#flushing = run;
    return run;
  }
}
