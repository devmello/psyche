import { newIdempotencyKey } from "./client.ts";

/**
 * The `chat.send` outbox (remote-gateway design §4.5, mobile design §2.3): messages typed while the
 * connection to the Gateway is down wait here and go out, in order, once it is back. Each carries
 * the idempotency key it was queued under, and every attempt re-sends that same key, so a send
 * whose answer was lost with the connection is replayed by the Gateway rather than run twice:
 * the message is delivered exactly once. The queue is plain data over a key-value store, so the
 * desktop's remote window and the phone's web client share it.
 *
 * Several windows may share one store. Every change re-reads the store and applies itself to what
 * is there (add this key, drop that key), so one window never overwrites another's messages, and a
 * store that announces changes (`onChange`, the `storage` event) keeps every window's list fresh.
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
  /** Failed attempts that waiting does not explain (the Gateway answered with an error). */
  failures?: number;
  /** The owner chose "Send now" for a message that had waited past `OUTBOX_STALE_MS`. */
  confirmed?: true;
}

export interface OutboxStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  /** Calls back when another window changed the store; returns an unsubscribe. */
  onChange?(key: string, cb: () => void): () => void;
}

export const OUTBOX_STORAGE_KEY = "psyche.chat-outbox.v1";
const OWNER_KEY = "psyche.chat-outbox.device.v1";

/** Wire codes where waiting and trying again can work; any other answer is final. */
const TRANSIENT = new Set(["unavailable", "timeout", "rate_limited", "internal", "cancelled"]);
/** Codes that mean the connection, not the message: they never count against it. */
const CONNECTION = new Set(["unavailable", "timeout"]);

/** After this many answered failures a message is given up on and handed back to the owner. */
export const OUTBOX_MAX_FAILURES = 5;
/** A message that waited longer than this asks before it goes out. */
export const OUTBOX_STALE_MS = 24 * 60 * 60_000;

export function outboxItemIsStale(item: OutboxItem, nowMs: number = Date.now()): boolean {
  return item.confirmed !== true && nowMs - Date.parse(item.createdAt) > OUTBOX_STALE_MS;
}

export interface FlushResult {
  sent: number;
  /** Messages given up on: refused for good, or failed too many times. */
  dropped: { item: OutboxItem; error: unknown }[];
  /** Stopped at a message that could not be sent yet; the rest still wait. */
  blocked: boolean;
  /** Stopped at a message that waited too long and needs the owner's "Send now". */
  stale?: OutboxItem;
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
  readonly #nowMs: () => number;
  readonly #requireOwner: boolean;
  readonly #listeners = new Set<() => void>();
  #owner: string | undefined;
  #flushing: Promise<FlushResult> | null = null;

  constructor(
    storage: OutboxStorage,
    options: {
      storageKey?: string;
      now?: () => string;
      nowMs?: () => number;
      /** Hold every send until `bindOwner` says whose messages these are (a remote window). */
      requireOwner?: boolean;
    } = {},
  ) {
    this.#storage = storage;
    this.#storageKey = options.storageKey ?? OUTBOX_STORAGE_KEY;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#nowMs = options.nowMs ?? Date.now;
    this.#requireOwner = options.requireOwner ?? false;
    storage.onChange?.(this.#storageKey, () => this.#emit());
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

  #emit(): void {
    for (const l of this.#listeners) l();
  }

  /** Applies one change to what the store holds now, so another window's messages survive. */
  #change(fn: (items: OutboxItem[]) => OutboxItem[]): void {
    const next = fn(this.#load());
    try {
      this.#storage.set(this.#storageKey, JSON.stringify(next));
    } catch {
      // A full or blocked store only costs persistence across a restart, not this session.
    }
    this.#emit();
  }

  /** What waits, oldest first; a snapshot of the store, never a live array. */
  items(threadId?: string): readonly OutboxItem[] {
    const all = this.#load();
    return threadId === undefined ? all : all.filter((i) => i.params.threadId === threadId);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Says whose messages these are (this computer's device id for the Gateway). Messages queued
   * under another device (the owner forgot this Gateway and paired again) are dropped rather than
   * sent as someone they were not written as.
   */
  bindOwner(owner: string): void {
    const previous = this.#storage.get(OWNER_KEY);
    if (previous !== null && previous !== owner) this.#change(() => []);
    try {
      this.#storage.set(OWNER_KEY, owner);
    } catch {
      // See `#change`.
    }
    this.#owner = owner;
    this.#emit();
  }

  /** Queues a message under a fresh idempotency key. Throws when the outbox is full. */
  enqueue(params: OutboxParams): OutboxItem {
    if (this.#load().length >= OUTBOX_MAX_ITEMS) throw new Error("outbox full");
    const item: OutboxItem = {
      key: `outbox:${newIdempotencyKey()}`,
      params: {
        threadId: params.threadId,
        content: params.content,
        ...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {}),
      },
      createdAt: this.#now(),
    };
    this.#change((items) => [...items, item]);
    return item;
  }

  /** Removes a waiting message (the owner changed their mind); `false` if it already went out. */
  remove(key: string): boolean {
    if (!this.#load().some((i) => i.key === key)) return false;
    this.#change((items) => items.filter((i) => i.key !== key));
    return true;
  }

  /** "Send now" for a message that waited past `OUTBOX_STALE_MS`. */
  confirm(key: string): void {
    this.#change((items) =>
      items.map((i) => (i.key === key ? { ...i, confirmed: true as const } : i)),
    );
  }

  /**
   * Sends everything that waits, oldest first, one at a time. A message leaves the queue only after
   * its send settles. A failure that waiting can fix stops the run and keeps it (and everything
   * behind it, so order holds); a final refusal, or too many answered failures, drops that message
   * and goes on. A message that waited past `OUTBOX_STALE_MS` stops the run until the owner
   * confirms it. Two calls at once share one run, so nothing is sent twice by two triggers.
   */
  flush(send: (item: OutboxItem) => Promise<unknown>): Promise<FlushResult> {
    if (this.#flushing !== null) return this.#flushing;
    const run = (async (): Promise<FlushResult> => {
      const result: FlushResult = { sent: 0, dropped: [], blocked: false };
      if (this.#requireOwner && this.#owner === undefined) {
        result.blocked = true;
        return result;
      }
      for (;;) {
        const item = this.#load()[0];
        if (item === undefined) return result;
        if (outboxItemIsStale(item, this.#nowMs())) {
          result.stale = item;
          result.blocked = true;
          return result;
        }
        try {
          await send(item);
          result.sent += 1;
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (typeof code !== "string" || TRANSIENT.has(code)) {
            // Waiting can fix a lost connection; an answered error that keeps coming back cannot.
            if (typeof code === "string" && !CONNECTION.has(code)) {
              const failures = (item.failures ?? 0) + 1;
              if (failures >= OUTBOX_MAX_FAILURES) {
                result.dropped.push({ item, error });
                this.#change((items) => items.filter((i) => i.key !== item.key));
                continue;
              }
              this.#change((items) =>
                items.map((i) => (i.key === item.key ? { ...i, failures } : i)),
              );
            }
            result.blocked = true;
            return result;
          }
          result.dropped.push({ item, error });
        }
        // The owner may have removed it while it was in flight; either way it is done.
        this.#change((items) => items.filter((i) => i.key !== item.key));
      }
    })().finally(() => {
      this.#flushing = null;
    });
    this.#flushing = run;
    return run;
  }
}
