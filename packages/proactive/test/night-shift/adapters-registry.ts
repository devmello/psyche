import type {
  CalendarEventInfo,
  MailDraftInfo,
  MailThreadInfo,
  ReadRegistry,
  ReminderInfo,
} from "../../src/night-shift/adapters/types.ts";

/** A fake read-only registry. Tests mutate the maps to make an item stale. */
export class FakeRegistry implements ReadRegistry {
  threads = new Map<string, MailThreadInfo>();
  drafts = new Map<string, MailDraftInfo>();
  events = new Map<string, CalendarEventInfo>();
  reminders = new Map<string, ReminderInfo>();
  failing = false;
  /** Resolved reply recipients by message id, as the registry would read them (Reply-To first). */
  replyTo = new Map<string, string[]>();
  /** Addresses the owner has ever sent to. */
  sentTo = new Set<string>(["ann@x.com", "bob@x.com"]);

  #guard(): void {
    if (this.failing) throw new Error("registry down");
  }

  async mailThread(ref: { threadId?: string; messageId?: string }) {
    this.#guard();
    const id = ref.threadId ?? (ref.messageId ? `t-${ref.messageId}` : "");
    return this.threads.get(id) ?? null;
  }
  async mailReplyRecipients(ref: { messageId: string; replyAll: boolean }) {
    this.#guard();
    const own = this.replyTo.get(ref.messageId);
    if (own) return own;
    return this.threads.has(`t-${ref.messageId}`) || this.threads.has("t-1")
      ? ref.replyAll
        ? ["ann@x.com", "bob@x.com"]
        : ["ann@x.com"]
      : null;
  }
  async mailSentTo(addresses: string[]) {
    this.#guard();
    return addresses.filter((a) => this.sentTo.has(a));
  }
  async mailDraft(id: string) {
    this.#guard();
    return this.drafts.get(id) ?? null;
  }
  async calendarEvent(ref: { id: string; calendarId?: string }) {
    this.#guard();
    return this.events.get(ref.id) ?? null;
  }
  async calendarFind(q: { title: string; start: string }) {
    this.#guard();
    return [...this.events.values()].filter((e) => e.title === q.title && e.start === q.start);
  }
  async reminder(id: string) {
    this.#guard();
    return this.reminders.get(id) ?? null;
  }
  async remindersFind(q: { title: string; listId?: string }) {
    this.#guard();
    return [...this.reminders.values()].filter(
      (r) => r.title === q.title && (q.listId === undefined || r.listId === q.listId),
    );
  }
}

export function thread(over: Partial<MailThreadInfo> = {}): MailThreadInfo {
  return {
    threadId: "t-1",
    newestMessageId: "m-9",
    count: 3,
    participants: ["owner@x.com", "Ann <ann@x.com>", "bob@x.com"],
    ...over,
  };
}

export function event(over: Partial<CalendarEventInfo> = {}): CalendarEventInfo {
  return {
    id: "e-1",
    etag: "v1",
    title: "Focus",
    start: "2026-11-25T09:00:00Z",
    end: "2026-11-25T10:00:00Z",
    attendees: [],
    fields: { title: "Focus", location: "Desk" },
    ...over,
  };
}

export function reminder(over: Partial<ReminderInfo> = {}): ReminderInfo {
  return {
    id: "r-1",
    listId: "L",
    modifiedAt: "2026-11-24T10:00:00Z",
    title: "Call dentist",
    completed: false,
    fields: { notes: "before" },
    ...over,
  };
}
