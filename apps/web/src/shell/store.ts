import type { ApprovalRequest, Message, Notification, ThreadListEntry } from "@psyche/protocol";
import type { GatewayEvent } from "../client/connection.ts";
import { type GatewayStatus, INITIAL_STATUS } from "../client/status.ts";
import type { GatewayPort, Unsubscribe } from "./platform.ts";

/**
 * Client-side view of Gateway state for the shell. It renders what the Gateway sends and
 * decides nothing (docs/06 §1.2 "the client never decides"): approvals are only shown and
 * answered through `approvals.answer`. Everything here is refetchable; on resync the store
 * reloads its collections.
 */

export interface Toast {
  id: string;
  text: string;
  tone: "info" | "warn" | "error";
}

export interface ShellState {
  status: GatewayStatus;
  threads: ThreadListEntry[];
  messages: Record<string, Message[]>;
  /** Streaming text per messageId from `chat.delta`, cleared when the message commits. */
  streaming: Record<string, { threadId: string; text: string }>;
  approvals: ApprovalRequest[];
  /** approvalId → this surface's single-use answer token, when the Gateway delivered one. */
  answerTokens: Record<string, string>;
  notifications: Notification[];
  toasts: Toast[];
  /** Methods the Gateway answered with unknown_method / not_implemented. */
  unavailable: string[];
}

const INITIAL: ShellState = {
  status: INITIAL_STATUS,
  threads: [],
  messages: {},
  streaming: {},
  approvals: [],
  answerTokens: {},
  notifications: [],
  toasts: [],
  unavailable: [],
};

function errCode(err: unknown): string | undefined {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

export function isUnavailableError(err: unknown): boolean {
  const c = errCode(err);
  return c === "unknown_method" || c === "not_implemented" || c === "unavailable";
}

let toastSeq = 0;

/** Plain one-line text of a message for the thread list's last line (UI design §2.2). */
export function lastLineOf(m: Message): string {
  return m.blocks
    .map((b) => (b.type === "text" ? b.md : ""))
    .join(" ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** A committed user or agent message becomes its thread's last line. */
function withLastLine(threads: ThreadListEntry[], m: Message): ThreadListEntry[] {
  if (m.role !== "user" && m.role !== "agent") return threads;
  const text = lastLineOf(m);
  if (text === "") return threads;
  return threads.map((t) =>
    t.thread.id === m.threadId
      ? {
          ...t,
          thread: { ...t.thread, lastMessageAt: m.createdAt },
          lastMessage: { role: m.role as "user" | "agent", text, at: m.createdAt },
        }
      : t,
  );
}

export class ShellStore {
  private state: ShellState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly offs: Unsubscribe[] = [];
  private readonly gateway: GatewayPort;
  /** Extra event consumers (pane layout's `view.command`, browser toasts). */
  private readonly eventTaps = new Set<(e: GatewayEvent) => void>();

  constructor(gateway: GatewayPort) {
    this.gateway = gateway;
  }

  start(): void {
    void this.gateway.getStatus().then((s) => this.onStatus(s));
    this.offs.push(this.gateway.onStatus((s) => this.onStatus(s)));
    this.offs.push(this.gateway.onEvent((e) => this.onEvent(e)));
    this.offs.push(this.gateway.onResync(() => void this.refresh()));
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
  }

  getState = (): ShellState => this.state;

  subscribe = (cb: () => void): Unsubscribe => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  tap(cb: (e: GatewayEvent) => void): Unsubscribe {
    this.eventTaps.add(cb);
    return () => this.eventTaps.delete(cb);
  }

  private set(patch: Partial<ShellState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /**
   * Shows a toast. Errors stay until dismissed; others close after `ttlMs` (8 s), and the timer
   * pauses while the pointer or focus is on the toasts (WCAG 2.2.1; docs/a11y-audit.md T1).
   */
  toast(text: string, tone: Toast["tone"] = "info", ttlMs = 8_000): void {
    const id = `t${++toastSeq}`;
    this.set({ toasts: [...this.state.toasts, { id, text, tone }] });
    if (tone !== "error") this.#arm(id, ttlMs);
  }

  dismissToast(id: string): void {
    const t = this.#toastTimers.get(id);
    if (t) clearTimeout(t.timer);
    this.#toastTimers.delete(id);
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  /** Pauses (true) or resumes (false) every toast's timer. */
  holdToasts(hold: boolean): void {
    if (hold === this.#toastsHeld) return;
    this.#toastsHeld = hold;
    const now = Date.now();
    for (const [id, t] of this.#toastTimers) {
      if (hold) {
        clearTimeout(t.timer);
        t.remaining = Math.max(0, t.deadline - now);
      } else this.#arm(id, t.remaining);
    }
  }

  #toastTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; deadline: number; remaining: number }
  >();
  #toastsHeld = false;

  #arm(id: string, ms: number): void {
    const timer = setTimeout(() => this.dismissToast(id), ms);
    this.#toastTimers.set(id, { timer, deadline: Date.now() + ms, remaining: ms });
    if (this.#toastsHeld) {
      clearTimeout(timer);
    }
  }

  /** Calls a method; marks it unavailable instead of throwing when the Gateway lacks it. */
  async call<T = unknown>(method: string, params: unknown): Promise<T | undefined> {
    try {
      return (await this.gateway.call(method, params)) as T;
    } catch (err) {
      if (isUnavailableError(err) && errCode(err) !== "unavailable") {
        if (!this.state.unavailable.includes(method))
          this.set({ unavailable: [...this.state.unavailable, method] });
        return undefined;
      }
      throw err;
    }
  }

  private onStatus(status: GatewayStatus): void {
    const wasPaired = this.state.status.phase === "paired";
    this.set({ status });
    if (!wasPaired && status.phase === "paired") void this.refresh();
  }

  async refresh(): Promise<void> {
    const [threads, approvals, notifications] = await Promise.allSettled([
      this.call<{ threads: ThreadListEntry[] }>("threads.list", {}),
      this.call<{ approvals: ApprovalRequest[]; answerTokens?: Record<string, string> }>(
        "approvals.list",
        {},
      ),
      this.call<{ notifications: Notification[] }>("notifications.list", {}),
    ]);
    this.set({
      ...(threads.status === "fulfilled" && threads.value
        ? { threads: threads.value.threads }
        : {}),
      ...(approvals.status === "fulfilled" && approvals.value
        ? {
            approvals: approvals.value.approvals.filter((a) => a.status === "pending"),
            answerTokens: { ...this.state.answerTokens, ...approvals.value.answerTokens },
          }
        : {}),
      ...(notifications.status === "fulfilled" && notifications.value
        ? { notifications: notifications.value.notifications }
        : {}),
    });
    for (const threadId of Object.keys(this.state.messages)) void this.loadHistory(threadId);
  }

  async loadHistory(threadId: string): Promise<void> {
    const res = await this.call<{ messages: Message[] }>("chat.history", { threadId }).catch(
      () => undefined,
    );
    if (!res) return;
    const sorted = [...res.messages].sort((a, b) => a.seq - b.seq);
    this.set({ messages: { ...this.state.messages, [threadId]: sorted } });
  }

  /**
   * Answers an approval with this surface's token (fetched with `approvals.get` when the list
   * did not carry it). The Gateway enforces binding, expiry, device-only and Touch ID.
   */
  async answerApproval(
    approvalId: string,
    decision: "approve" | "deny",
    scope?: string,
  ): Promise<void> {
    let token = this.state.answerTokens[approvalId];
    if (!token) {
      const got = await this.call<{ answerToken?: string }>("approvals.get", { approvalId });
      token = got?.answerToken;
    }
    if (!token) {
      this.toast(
        "This approval can't be answered here. Open it on the device it was sent to.",
        "warn",
      );
      return;
    }
    await this.gateway.call("approvals.answer", {
      approvalId,
      answerToken: token,
      decision,
      ...(scope ? { scope } : {}),
    });
    const { [approvalId]: _used, ...rest } = this.state.answerTokens;
    this.set({
      answerTokens: rest,
      approvals: this.state.approvals.filter((a) => a.id !== approvalId),
    });
  }

  private upsertMessage(m: Message): void {
    const list = this.state.messages[m.threadId] ?? [];
    const next = list
      .filter((x) => x.id !== m.id)
      .concat(m)
      .sort((a, b) => a.seq - b.seq);
    const { [m.id]: _done, ...streaming } = this.state.streaming;
    this.set({
      messages: { ...this.state.messages, [m.threadId]: next },
      streaming,
      threads: withLastLine(this.state.threads, m),
    });
  }

  private upsertApproval(a: ApprovalRequest): void {
    const rest = this.state.approvals.filter((x) => x.id !== a.id);
    this.set({ approvals: a.status === "pending" ? [...rest, a] : rest });
  }

  private onEvent(e: GatewayEvent): void {
    const p = e.payload as Record<string, unknown>;
    switch (e.event) {
      case "chat.delta": {
        const id = String(p.messageId);
        const prev = this.state.streaming[id]?.text ?? "";
        this.set({
          streaming: {
            ...this.state.streaming,
            [id]: { threadId: String(p.threadId), text: prev + String(p.delta) },
          },
        });
        break;
      }
      case "chat.message":
        this.upsertMessage(p.message as Message);
        break;
      case "thread.updated": {
        const thread = p.thread as ThreadListEntry["thread"];
        const existing = this.state.threads.find((t) => t.thread.id === thread.id);
        const entry: ThreadListEntry = {
          thread,
          activity: existing?.activity ?? { running: 0, awaitingInput: 0, awaitingApproval: 0 },
          ...(existing?.lastMessage === undefined ? {} : { lastMessage: existing.lastMessage }),
        };
        this.set({
          threads: [entry, ...this.state.threads.filter((t) => t.thread.id !== thread.id)],
        });
        break;
      }
      case "approval.created":
      case "approval.updated":
        this.upsertApproval(p.approval as ApprovalRequest);
        break;
      case "notification.created":
        this.set({
          notifications: [p.notification as Notification, ...this.state.notifications].slice(
            0,
            200,
          ),
        });
        break;
      case "gateway.shutdown":
        this.toast("The Gateway is restarting. Psyche will reconnect.", "warn");
        break;
    }
    for (const t of this.eventTaps) t(e);
  }
}
