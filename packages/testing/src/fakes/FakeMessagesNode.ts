import {
  MESSAGES_CAPABILITIES,
  type MessagesChat,
  type MessagesChatsParams,
  type MessagesChatsResult,
  type MessagesMessage,
  type MessagesReadParams,
  type MessagesReadResult,
  type MessagesSendParams,
  type MessagesSendResult,
  type MessagesService,
  type MessagesStatus,
  type MessagesWatchEvent,
  type MessagesWatchParams,
} from "@psyche/protocol";
import { FakeNodeClient } from "./FakeNodeClient.ts";

export interface FakeIncoming {
  chatId?: string;
  from: string;
  text: string | null;
  service?: MessagesService;
  isFromMe?: boolean;
  replyToGuid?: string;
  attachments?: MessagesMessage["attachments"];
  reaction?: MessagesMessage["reaction"];
}

/**
 * A mac-helper-shaped node serving `messages.*` (J7) over an in-memory chat.db. `receive(...)`
 * appends a row and pushes it to every open `messages.watch`; `messages.send` records the send
 * (`sends`) and, like Messages.app, writes an `isFromMe` row the watcher sees when
 * `includeFromMe` is set. `messages.send` needs an `approvalId` (FakeNodeClient enforces it for
 * destructive capabilities).
 */
export class FakeMessagesNode extends FakeNodeClient {
  readonly sends: (MessagesSendParams & { approvalId?: string })[] = [];
  status: MessagesStatus = {
    fullDiskAccess: true,
    automation: "granted",
    databasePresent: true,
    lastCursor: null,
  };
  /** When set, the next `messages.send` throws this message (Automation denied, Messages down). */
  failNextSend: string | null = null;
  #rows: MessagesMessage[] = [];
  #chats = new Map<string, MessagesChat>();
  #watchers = new Set<{ params: MessagesWatchParams; emit: (data: unknown) => void }>();
  #clock = Date.parse("2026-10-19T12:00:00.000Z");

  constructor(options: { nodeId?: string } = {}) {
    super({ nodeId: options.nodeId ?? "node_mac", kind: "mac-helper" });
    const cap = (name: string) => {
      const c = MESSAGES_CAPABILITIES.find((x) => x.name === name);
      if (c === undefined) throw new Error(name);
      return structuredClone(c);
    };
    this.handle({
      capability: cap("messages.status"),
      handle: () => ({ ...this.status, lastCursor: this.#lastCursor() }),
    });
    this.handle({
      capability: cap("messages.chats"),
      handle: (p) => this.#listChats((p ?? {}) as MessagesChatsParams),
    });
    this.handle({
      capability: cap("messages.read"),
      handle: (p) => this.#read((p ?? {}) as MessagesReadParams),
    });
    this.handle({
      capability: cap("messages.send"),
      handle: (p) => this.#send(p as MessagesSendParams),
    });
    this.handle({
      capability: cap("messages.watch"),
      handle: (p, emit, signal) => this.#watch((p ?? {}) as MessagesWatchParams, emit, signal),
    });
  }

  /** Appends one row (an inbound message, or the owner's own when `isFromMe`). */
  receive(input: FakeIncoming): MessagesMessage {
    const service = input.service ?? "imessage";
    const prefix = service === "sms" ? "SMS" : service === "rcs" ? "RCS" : "iMessage";
    const chatId = input.chatId ?? `${prefix};-;${input.from}`;
    const cursor = this.#lastCursor() === null ? 1 : (this.#lastCursor() ?? 0) + 1;
    this.#clock += 1000;
    const isFromMe = input.isFromMe === true;
    const msg: MessagesMessage = {
      cursor,
      guid: `guid-${cursor}`,
      chatId,
      service,
      isFromMe,
      sender: isFromMe ? null : { handle: input.from, service },
      text: input.text,
      sentAt: new Date(this.#clock).toISOString(),
      editedAt: null,
      replyToGuid: input.replyToGuid ?? null,
      reaction: input.reaction ?? null,
      attachments: input.attachments ?? [],
    };
    this.#rows.push(msg);
    const chat = this.#chats.get(chatId) ?? {
      chatId,
      service,
      displayName: null,
      isGroup: chatId.includes(";+;"),
      participants: [],
      lastMessageAt: null,
      lastCursor: null,
    };
    if (!isFromMe && !chat.participants.some((p) => p.handle === input.from)) {
      chat.participants.push({ handle: input.from, service });
    }
    chat.lastMessageAt = msg.sentAt;
    chat.lastCursor = cursor;
    this.#chats.set(chatId, chat);
    for (const w of this.#watchers) {
      if (isFromMe && w.params.includeFromMe !== true) continue;
      const event: MessagesWatchEvent = { type: "messages.new", messages: [msg], cursor };
      w.emit(structuredClone(event));
    }
    return msg;
  }

  /** Pushes a `messages.watch_error` to every open watcher. */
  watchError(reason: string, retryable = true): void {
    for (const w of this.#watchers) w.emit({ type: "messages.watch_error", reason, retryable });
  }

  get openWatches(): number {
    return this.#watchers.size;
  }

  #lastCursor(): number | null {
    return this.#rows.at(-1)?.cursor ?? null;
  }

  #requireAccess(): void {
    if (!this.status.fullDiskAccess) {
      throw new Error("forbidden/full_disk_access_missing");
    }
  }

  #listChats(p: MessagesChatsParams): MessagesChatsResult {
    this.#requireAccess();
    const q = p.query?.toLowerCase();
    const chats = [...this.#chats.values()]
      .filter(
        (c) =>
          q === undefined ||
          c.participants.some((h) => h.handle.toLowerCase().includes(q)) ||
          (c.displayName ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => (b.lastCursor ?? 0) - (a.lastCursor ?? 0))
      .slice(0, p.limit ?? 50);
    return { chats: structuredClone(chats) };
  }

  #read(p: MessagesReadParams): MessagesReadResult {
    this.#requireAccess();
    const limit = p.limit ?? 20;
    let rows = this.#rows.filter(
      (m) =>
        (p.chatId === undefined || m.chatId === p.chatId) &&
        (p.handle === undefined || m.sender?.handle === p.handle || m.chatId.endsWith(p.handle)),
    );
    let hasMore: boolean;
    if (p.sinceCursor !== undefined) {
      const since = p.sinceCursor;
      rows = rows.filter((m) => m.cursor > since);
      hasMore = rows.length > limit;
      rows = rows.slice(0, limit);
    } else {
      hasMore = rows.length > limit;
      rows = rows.slice(-limit);
    }
    const cursor = rows.at(-1)?.cursor ?? p.sinceCursor ?? null;
    return { messages: structuredClone(rows), cursor, hasMore };
  }

  #send(p: MessagesSendParams): MessagesSendResult {
    if (this.failNextSend !== null) {
      const message = this.failNextSend;
      this.failNextSend = null;
      throw new Error(message);
    }
    const recipient = p.chatId ?? p.to;
    if (recipient === undefined) throw new Error("invalid_params: to or chatId");
    const record: (typeof this.sends)[number] = { ...p };
    const last = this.invocations.at(-1);
    if (last?.approvalId !== undefined) record.approvalId = last.approvalId;
    this.sends.push(record);
    const chatId = p.chatId ?? `${p.service === "sms" ? "SMS" : "iMessage"};-;${p.to ?? recipient}`;
    this.receive({ chatId, from: p.to ?? recipient, text: p.text, isFromMe: true });
    return { sent: true, recipient, sentAt: new Date(this.#clock).toISOString() };
  }

  #watch(
    p: MessagesWatchParams,
    emit: (data: unknown) => void,
    signal: AbortSignal | undefined,
  ): Promise<null> {
    this.#requireAccess();
    const watcher = { params: p, emit };
    // Backfill rows after sinceCursor, as the helper's first poll does.
    if (p.sinceCursor !== undefined) {
      const since = p.sinceCursor;
      const backlog = this.#rows.filter(
        (m) => m.cursor > since && (p.includeFromMe === true || !m.isFromMe),
      );
      const last = backlog.at(-1);
      if (last !== undefined) {
        emit({ type: "messages.new", messages: structuredClone(backlog), cursor: last.cursor });
      }
    }
    this.#watchers.add(watcher);
    return new Promise((resolve) => {
      const stop = () => {
        this.#watchers.delete(watcher);
        resolve(null);
      };
      if (signal === undefined) return;
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    });
  }
}
